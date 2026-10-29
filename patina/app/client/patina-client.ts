// 휴대폰 쪽 로직 (DOM 없음). 키·관계 opening·슬롯 id·작성 내용은 전부 이 기기에만 있다.
// 서버로 나가는 건 서명, 해시, 봉인된 상자뿐이다.

import { generateKeyPair, hex, keyPairFromSeed, signMessage, systemRandom, fromHex, type KeyPair } from "../../src/crypto.js";
import {
  encodeContent,
  orderPair,
  relationshipCommitment,
  signedMessage,
  verificationDigits,
  type RelationshipOpening,
  type ReviewContent,
} from "../../src/messages.js";
import { sealToRoundKey } from "../../src/timelock.js";
import type { ReviewerTask } from "../../src/views.js";
import { normalizeCode, type InviteView, type PatinaApi } from "../api.js";

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

/** localStorage. 막혀 있으면(사생활 보호 모드 등) 메모리로 대신한다. */
export function browserStore(): KeyValueStore {
  const mem = memoryStore();
  return {
    get(k) {
      try {
        return globalThis.localStorage?.getItem(k) ?? mem.get(k);
      } catch {
        return mem.get(k);
      }
    },
    set(k, v) {
      mem.set(k, v);
      try {
        globalThis.localStorage?.setItem(k, v);
      } catch {
        /* 메모리에만 남는다 */
      }
    },
  };
}

export interface Contact {
  readonly id: string;
  readonly opening: RelationshipOpening;
  /** 상대 공개키. */
  readonly other: string;
  /** 이 기기에만 저장되는 이름. 서버로 가지 않는다. */
  nickname: string;
  /** 관계 공증 시각 (서버 기준). 아직 모르면 null. */
  anchoredAt: number | null;
}

export interface SlotRecord {
  readonly relationshipId: string;
  content: ReviewContent;
  /** 마지막으로 봉인해서 낸 라운드 (없으면 아직 봉인 전). */
  sealedRound?: number;
  /** 이번 수정 창에서 위장 수정(또는 진짜 수정)을 이미 했나. */
  touchedInWindow?: boolean;
  /** 이미 답한 재확인 체크포인트들. */
  answered: number[];
}

interface WalletData {
  v: 1;
  seed: string;
  contacts: Record<string, Contact>;
  slots: Record<string, SlotRecord>;
}

const STORE_KEY = "patina.wallet.v1";

export class PatinaClient {
  readonly api: PatinaApi;
  readonly keys: KeyPair;
  readonly #store: KeyValueStore;
  readonly #data: WalletData;
  /** 서버가 초기화돼서(데모 재시작 등) 이 기기의 관계가 서버에 없을 때 true. */
  serverWasReset = false;
  estAt: number | null = null;

  private constructor(api: PatinaApi, store: KeyValueStore, data: WalletData) {
    this.api = api;
    this.#store = store;
    this.#data = data;
    this.keys = keyPairFromSeed(fromHex(data.seed));
  }

  /** 저장된 키로 열거나 새 키를 만든다. 서버에 계정을 등록(이미 있으면 그대로)하고, 서버에 없는 관계는 정리한다. */
  static async open(api: PatinaApi, store: KeyValueStore, seedHex?: string): Promise<PatinaClient> {
    let data: WalletData | null = null;
    if (!seedHex) {
      try {
        data = JSON.parse(store.get(STORE_KEY) ?? "null") as WalletData | null;
      } catch {
        data = null;
      }
    }
    if (!data || data.v !== 1) {
      const seed = seedHex ?? hex(generateKeyPair(systemRandom).secretKey);
      if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("백업 문자열 형식이 아니에요 (64자리 16진수)");
      data = { v: 1, seed, contacts: {}, slots: {} };
    }
    const client = new PatinaClient(api, store, data);
    client.estAt = (await api.registerAccount(client.pub)).anchoredAt;
    for (const c of Object.values(data.contacts)) {
      const rec = await api.relationship(c.id);
      if (rec) {
        c.anchoredAt = rec.anchoredAt;
        continue;
      }
      client.serverWasReset = true;
      delete data.contacts[c.id];
      for (const [slotId, s] of Object.entries(data.slots)) if (s.relationshipId === c.id) delete data.slots[slotId];
    }
    client.#save();
    return client;
  }

  get pub(): string {
    return this.keys.publicKey;
  }

  exportSeed(): string {
    return this.#data.seed;
  }

  // ============================================================ 연결

  /** 내 초대코드를 새로 만든다. 이전 코드는 서버에서 닫힌다. */
  async createInvite(): Promise<InviteView> {
    const nonce = hex(systemRandom.bytes(32));
    return this.api.createInvite({ pub: this.pub, nonce, signature: signMessage(this.keys, signedMessage.invite(this.pub, nonce)) });
  }

  /** 상대 코드를 입력했다: 같은 관계에 서명해서 내고, 상대와 맞춰볼 확인 숫자를 돌려준다. */
  async acceptInvite(code: string): Promise<{ view: InviteView; digits: string }> {
    const invite = await this.api.getInvite(normalizeCode(code));
    if (invite.inviter === this.pub) throw new Error("내 코드는 내가 입력할 수 없어요");
    const opening = this.#opening(invite.inviter, this.pub, invite.nonce);
    const id = relationshipCommitment(opening);
    const view = await this.api.acceptInvite(invite.code, { pub: this.pub, signature: signMessage(this.keys, signedMessage.handshake(id)) });
    return { view, digits: verificationDigits(id) };
  }

  /** 내 초대에 누가 들어왔을 때 화면에 띄울 확인 숫자. */
  digitsFor(view: InviteView): string {
    if (!view.acceptor) throw new Error("아직 상대가 없어요");
    return verificationDigits(relationshipCommitment(this.#opening(view.inviter, view.acceptor, view.nonce)));
  }

  /** 확인 숫자가 같다고 사람이 확인한 뒤에만 부른다. */
  async confirmInvite(view: InviteView): Promise<InviteView> {
    if (view.inviter !== this.pub || !view.acceptor) throw new Error("승인할 수 있는 초대가 아니에요");
    const id = relationshipCommitment(this.#opening(view.inviter, view.acceptor, view.nonce));
    const done = await this.api.confirmInvite(view.code, { signature: signMessage(this.keys, signedMessage.handshake(id)) });
    if (done.status === "done") await this.remember(done);
    return done;
  }

  /** 완료된 초대를 내 관계 목록에 넣는다 (양쪽 모두 부른다). 이미 있으면 그대로 돌려준다. */
  async remember(view: InviteView): Promise<Contact | null> {
    if (view.status !== "done" || !view.relationshipId || !view.acceptor) return null;
    if (view.inviter !== this.pub && view.acceptor !== this.pub) return null;
    const existing = this.#data.contacts[view.relationshipId];
    if (existing) return existing;
    const opening = this.#opening(view.inviter, view.acceptor, view.nonce);
    if (relationshipCommitment(opening) !== view.relationshipId) throw new Error("관계 정보가 맞지 않아요");
    const contact: Contact = {
      id: view.relationshipId,
      opening,
      other: view.inviter === this.pub ? view.acceptor : view.inviter,
      nickname: `관계 ${Object.keys(this.#data.contacts).length + 1}`,
      anchoredAt: null,
    };
    this.#data.contacts[contact.id] = contact;
    this.#save();
    return contact;
  }

  rename(id: string, nickname: string): void {
    const c = this.#data.contacts[id];
    if (!c) return;
    c.nickname = nickname.trim().slice(0, 30) || c.nickname;
    this.#save();
  }

  contacts(): Contact[] {
    return Object.values(this.#data.contacts);
  }

  // ============================================================ 평가

  slotOf(relationshipId: string): { slotId: string; record: SlotRecord } | undefined {
    for (const [slotId, record] of Object.entries(this.#data.slots)) if (record.relationshipId === relationshipId) return { slotId, record };
    return undefined;
  }

  /**
   * 평가 자리를 잡고(관계당 1회, 취소 불가) 봉인한다. 공개 지연은 등록 뒤 다음 비콘 라운드(몇 초)에 정해지므로,
   * waitMs 를 주면 그동안 기다렸다가 그 자리에서 봉인까지 끝낸다. 못 끝내면 refresh 가 이어서 한다
   * (단, 공개 시각 전에 앱을 다시 열어야 한다. 봉인 없이 공개 시각이 지나면 그 평가는 사라진다).
   */
  async startReview(relationshipId: string, content: ReviewContent, opts: { waitMs?: number } = {}): Promise<string> {
    const c = this.#data.contacts[relationshipId];
    if (!c) throw new Error("없는 관계예요");
    if (this.slotOf(relationshipId)) throw new Error("이 관계엔 이미 평가를 남겼어요");
    const { slotId } = await this.api.registerReview({
      relationshipId,
      opening: c.opening,
      reviewer: this.pub,
      signature: signMessage(this.keys, signedMessage.register(relationshipId, this.pub)),
    });
    this.#data.slots[slotId] = { relationshipId, content, answered: [] };
    this.#save();
    await this.#sealWithin([slotId], opts.waitMs ?? 0);
    return slotId;
  }

  /** 아직 봉인 못 한 평가를 최대 waitMs 동안 기다려 가며 봉인한다. 남은 개수를 돌려준다. */
  async sealPending(waitMs: number): Promise<number> {
    const pending = Object.entries(this.#data.slots).filter(([, s]) => s.sealedRound === undefined).map(([id]) => id);
    return this.#sealWithin(pending, waitMs);
  }

  async #sealWithin(slotIds: string[], waitMs: number): Promise<number> {
    const deadline = Date.now() + waitMs;
    let left = slotIds.filter((id) => this.#data.slots[id]?.sealedRound === undefined);
    for (;;) {
      const next: string[] = [];
      for (const id of left) if (!(await this.#trySeal(id))) next.push(id);
      left = next;
      if (left.length === 0 || Date.now() >= deadline) return left.length;
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  /** 수정 창 안에서 내용을 바꾼다. 몇 번이든 되고, 마지막 것만 남는다. */
  async edit(slotId: string, content: ReviewContent): Promise<void> {
    const s = this.#data.slots[slotId];
    if (!s) throw new Error("없는 평가예요");
    const previous = s.content;
    s.content = content;
    try {
      await this.#seal(slotId, s);
    } catch (e) {
      s.content = previous;
      throw e;
    }
    s.touchedInWindow = true;
    this.#save();
  }

  /**
   * 주기적으로 부른다: 아직 봉인 못 한 평가를 봉인하고, 수정 창이 열린 평가는 한 번 위장 수정(같은 내용 재봉인)한다.
   * 그래서 밖에서 보면 모든 평가가 수정 창에서 한 번씩 고쳐진 것처럼 보인다.
   */
  async refresh(): Promise<ReviewerTask[]> {
    const ids = Object.keys(this.#data.slots);
    for (const slotId of ids) {
      const s = this.#data.slots[slotId]!;
      if (s.sealedRound === undefined) await this.#trySeal(slotId);
    }
    const tasks = ids.length ? await this.api.tasks(ids) : [];
    for (const t of tasks) {
      const s = this.#data.slots[t.slotId];
      if (t.kind === "edit" && s && !s.touchedInWindow) {
        await this.#seal(t.slotId, s);
        s.touchedInWindow = true;
        this.#save();
      }
    }
    return tasks.filter((t) => t.kind === "edit" || !this.#data.slots[t.slotId]?.answered.includes(t.checkpoint));
  }

  async reaffirm(slotId: string, checkpoint: number): Promise<void> {
    await this.api.reaffirm({ slotId, checkpoint, signature: signMessage(this.keys, signedMessage.reaffirm(slotId, checkpoint)) });
    this.#answer(slotId, checkpoint);
  }

  /** 재확인하지 않기: 아무것도 보내지 않는다 (기한이 지나면 조용히 사라진다). 이 기기에서만 "답함"으로 표시. */
  decline(slotId: string, checkpoint: number): void {
    this.#answer(slotId, checkpoint);
  }

  // ============================================================ 내부

  #answer(slotId: string, checkpoint: number): void {
    const s = this.#data.slots[slotId];
    if (s && !s.answered.includes(checkpoint)) s.answered.push(checkpoint);
    this.#save();
  }

  async #trySeal(slotId: string): Promise<boolean> {
    const s = this.#data.slots[slotId];
    if (!s) return false;
    if (!(await this.api.schedule(slotId))) return false;
    await this.#seal(slotId, s);
    return true;
  }

  /** 라운드 공개키만 받아서 이 기기에서 봉인한다. 서버는 평문을 보지 못한다. */
  async #seal(slotId: string, s: SlotRecord): Promise<void> {
    const schedule = await this.api.schedule(slotId);
    if (!schedule) throw new Error("아직 공개 시점이 정해지지 않았어요. 잠시 뒤 다시 시도해 주세요");
    const roundKey = fromHex(await this.api.roundKey(schedule.revealRound));
    const box = sealToRoundKey(encodeContent(s.content), schedule.revealRound, roundKey);
    await this.api.submitSealed({
      slotId,
      round: box.round,
      ciphertext: box.ciphertext.toString("base64"),
      signature: signMessage(this.keys, signedMessage.seal(slotId, box.round, box.ciphertext)),
    });
    s.sealedRound = box.round;
    this.#save();
  }

  #opening(x: string, y: string, nonce: string): RelationshipOpening {
    const [a, b] = orderPair(x, y);
    return { a, b, nonce };
  }

  #save(): void {
    this.#store.set(STORE_KEY, JSON.stringify(this.#data));
  }
}
