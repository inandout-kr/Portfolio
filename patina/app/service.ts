// 운영자 노드 서비스. 엔진 + 초대코드 + (데모) 가상 친구·시간 빨리 감기.
// 진짜 서버(app/server.ts)와 브라우저 데모(app/standalone.ts)가 이 클래스를 그대로 쓴다.

import { MockBeacon } from "../src/beacon.js";
import { Member } from "../src/client.js";
import type { PatinaConfig } from "../src/config.js";
import { SeededRandom, hex, randomFloat, randomInt, sha256, signMessage, systemRandom, verifyMessage, type RandomSource } from "../src/crypto.js";
import { PatinaEngine, ProtocolError } from "../src/engine.js";
import { orderPair, relationshipCommitment, signedMessage, type RelationshipOpening, type ReviewContent } from "../src/messages.js";
import type { ReviewRegistration } from "../src/membership.js";
import { InMemoryChain, TimeNotary } from "../src/notary.js";
import { DAY, MINUTE, YEAR, systemClock, type Clock } from "../src/time.js";
import { MockTimelock } from "../src/timelock.js";
import type { ProfileView, ReviewerTask } from "../src/views.js";
import { ApiError, CODE_ALPHABET, normalizeCode, type AppInfo, type InviteView, type PatinaApi, type ScheduleView, type SealedSubmission } from "./api.js";

/** 데모용 시계: 실제 시간을 따라가되, 빨리 감은 만큼 앞서 있다. 되감기는 없다. */
export class OffsetClock implements Clock {
  #offset = 0;

  now(): number {
    return Date.now() + this.#offset;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError("시계는 되돌릴 수 없다");
    this.#offset += ms;
  }
}

export interface AppServiceOptions {
  /** 데모 모드: 가상 친구·시간 빨리 감기 허용. 실서버는 false. */
  readonly demo: boolean;
  /** 주면 서버 비밀값·초대코드·가상 친구가 재현 가능해진다 (테스트용). */
  readonly seed?: string;
  readonly config?: Partial<PatinaConfig>;
  /** 기본: 데모면 OffsetClock, 아니면 시스템 시계. */
  readonly clock?: Clock;
}

interface Invite {
  readonly code: string;
  readonly inviter: string;
  readonly nonce: string;
  readonly expiresAt: number;
  acceptor?: string;
  acceptorSignature?: string;
  relationshipId?: string;
  error?: string;
  /** 가상 친구가 만든 초대면, 누가 수락하는 순간 친구가 바로 승인한다. */
  readonly botInviter?: Bot;
}

interface Plan {
  readonly registerAt: number;
  slotId?: string;
  written: boolean;
  readonly decided: Set<string>;
}

interface Bot {
  readonly member: Member;
  readonly plans: Map<string, Plan>;
}

const INVITE_TTL = 10 * MINUTE;
const INVITE_KEEP = 30 * MINUTE;
const BOT_TEXTS = {
  endorse: ["약속 시간 정확", "빌린 걸 제때 돌려줌", "거래 설명이 사진과 똑같았다", "어려울 때 먼저 연락해 줌", "스터디 자료를 늘 먼저 공유"],
  neutral: ["연락이 가끔 늦다", "나쁘진 않은데 기복이 있다"],
};

export class AppService implements PatinaApi {
  readonly demo: boolean;
  readonly clock: Clock;
  readonly engine: PatinaEngine;
  readonly timelock: MockTimelock;
  readonly #rng: RandomSource;
  readonly #botRng: RandomSource;
  readonly #invites = new Map<string, Invite>();
  readonly #bots = new Map<string, Bot>();
  #tickChain: Promise<void> = Promise.resolve();

  constructor(opts: AppServiceOptions) {
    this.demo = opts.demo;
    const secret = (label: string): Buffer => (opts.seed ? sha256(opts.seed, label) : systemRandom.bytes(32));
    this.#rng = opts.seed ? new SeededRandom(sha256(opts.seed, "service")) : systemRandom;
    this.#botRng = opts.seed ? new SeededRandom(sha256(opts.seed, "bots")) : systemRandom;
    this.clock = opts.clock ?? (opts.demo ? new OffsetClock() : systemClock);
    const beacon = new MockBeacon({ clock: this.clock, seed: secret("beacon") });
    this.timelock = new MockTimelock(beacon, secret("tlock"), this.#rng);
    this.engine = new PatinaEngine({
      clock: this.clock,
      beacon,
      timelock: this.timelock,
      notary: new TimeNotary(new InMemoryChain(this.clock)),
      rng: this.#rng,
      operatorSecret: secret("operator"),
      ...(opts.config ? { config: opts.config } : {}),
    });
  }

  /** 시간 진행 한 번: 엔진 tick + (데모) 가상 친구 행동. 겹쳐 돌지 않게 줄 세운다. */
  tick(): Promise<void> {
    this.#tickChain = this.#tickChain
      .then(async () => {
        await this.engine.tick();
        if (this.demo) await this.#botsStep();
        this.#gcInvites();
      })
      .catch((e: unknown) => console.error("[patina] tick 실패", e));
    return this.#tickChain;
  }

  // ============================================================ PatinaApi

  async info(): Promise<AppInfo> {
    const c = this.engine.config;
    return {
      demo: this.demo,
      now: this.clock.now(),
      batchSize: c.batchSize,
      warningThreshold: c.warningThreshold,
      minDelay: c.minDelay,
      maxDelay: c.maxDelay,
      editWindow: c.editWindow,
      minRelationshipAge: c.minRelationshipAge,
      maxTextLength: c.maxTextLength,
    };
  }

  async registerAccount(pub: string): Promise<{ anchoredAt: number | null }> {
    return guard(() => {
      if (!this.engine.accountRecord(pub)) this.engine.registerAccount(pub);
      return { anchoredAt: this.engine.accountRecord(pub)!.anchoredAt };
    });
  }

  async createInvite(req: { pub: string; nonce: string; signature: string }): Promise<InviteView> {
    return guard(() => this.#view(this.#createInvite(req.pub, req.nonce, req.signature)));
  }

  async getInvite(code: string): Promise<InviteView> {
    return guard(() => this.#view(this.#invite(code)));
  }

  async acceptInvite(code: string, req: { pub: string; signature: string }): Promise<InviteView> {
    return guard(() => {
      const inv = this.#invite(code);
      if (this.#status(inv) !== "open") throw new ApiError("invite-closed", "이미 쓰였거나 만료된 코드예요");
      if (req.pub === inv.inviter) throw new ApiError("self", "내 코드는 내가 입력할 수 없어요");
      this.#requireAccount(req.pub);
      const id = relationshipCommitment(openingOf(inv.inviter, req.pub, inv.nonce));
      if (!verifyMessage(req.pub, signedMessage.handshake(id), req.signature)) {
        throw new ApiError("bad-signature", "서명이 맞지 않아요");
      }
      inv.acceptor = req.pub;
      inv.acceptorSignature = req.signature;
      if (inv.botInviter) this.#complete(inv, sign(inv.botInviter.member, signedMessage.handshake(id)));
      return this.#view(inv);
    });
  }

  async confirmInvite(code: string, req: { signature: string }): Promise<InviteView> {
    return guard(() => {
      const inv = this.#invite(code);
      if (this.#status(inv) !== "accepted") throw new ApiError("invite-not-accepted", "아직 상대가 코드를 입력하지 않았어요");
      const id = relationshipCommitment(openingOf(inv.inviter, inv.acceptor!, inv.nonce));
      if (!verifyMessage(inv.inviter, signedMessage.handshake(id), req.signature)) {
        throw new ApiError("bad-signature", "서명이 맞지 않아요");
      }
      this.#complete(inv, req.signature);
      return this.#view(inv);
    });
  }

  async relationship(id: string): Promise<{ id: string; anchoredAt: number | null } | null> {
    return this.engine.relationshipRecord(id) ?? null;
  }

  async registerReview(reg: ReviewRegistration): Promise<{ slotId: string }> {
    return guard(() => this.engine.registerReview(reg));
  }

  async schedule(slotId: string): Promise<ScheduleView | null> {
    return this.engine.schedule(slotId) ?? null;
  }

  async roundKey(round: number): Promise<string> {
    return guard(() => {
      if (!Number.isSafeInteger(round) || round < 1) throw new ApiError("bad-request", "잘못된 라운드");
      return hex(this.timelock.roundPublicKey(round));
    });
  }

  async submitSealed(sub: SealedSubmission): Promise<{ ok: true }> {
    return guard(() =>
      this.engine.submitSealed(sub.slotId, { round: sub.round, ciphertext: Buffer.from(sub.ciphertext, "base64") }, sub.signature),
    );
  }

  async tasks(slotIds: readonly string[]): Promise<ReviewerTask[]> {
    return this.engine.reviewerTasks(slotIds.slice(0, 1000));
  }

  async reaffirm(req: { slotId: string; checkpoint: number; signature: string }): Promise<{ ok: true }> {
    return guard(() => this.engine.reaffirm(req.slotId, req.checkpoint, req.signature));
  }

  async profile(pub: string): Promise<ProfileView> {
    return this.engine.view(pub);
  }

  // ---------------------------------------------------------------- 데모 전용

  async demoAdvance(ms: number): Promise<{ now: number }> {
    this.#requireDemo();
    if (!(ms > 0) || ms > 5 * YEAR) throw new ApiError("bad-request", "0초에서 5년 사이로만 감을 수 있어요");
    const clock = this.clock as OffsetClock;
    let left = ms;
    while (left > 0) {
      const step = Math.min(DAY, left);
      clock.advance(step);
      left -= step;
      await this.tick();
    }
    return { now: this.clock.now() };
  }

  async demoBotInvite(): Promise<InviteView> {
    this.#requireDemo();
    const bot = this.#newBot();
    const nonce = hex(this.#botRng.bytes(32));
    const inv = this.#createInvite(bot.member.pub, nonce, sign(bot.member, signedMessage.invite(bot.member.pub, nonce)), bot);
    return this.#view(inv);
  }

  async demoBotJoin(code: string): Promise<InviteView> {
    this.#requireDemo();
    const bot = this.#newBot();
    const inv = this.#invite(code);
    const id = relationshipCommitment(openingOf(inv.inviter, bot.member.pub, inv.nonce));
    return this.acceptInvite(code, { pub: bot.member.pub, signature: sign(bot.member, signedMessage.handshake(id)) });
  }

  // ============================================================ 내부

  #createInvite(pub: string, nonce: string, signature: string, botInviter?: Bot): Invite {
    if (!/^[0-9a-f]{64}$/.test(nonce)) throw new ApiError("bad-request", "nonce 형식이 틀렸어요");
    this.#requireAccount(pub);
    if (!verifyMessage(pub, signedMessage.invite(pub, nonce), signature)) throw new ApiError("bad-signature", "서명이 맞지 않아요");
    // 한 사람에게 열린 초대는 하나만: 새 코드를 만들면 이전 코드는 (상대가 입력했어도) 닫힌다 = 거절
    for (const [code, other] of this.#invites) {
      const st = this.#status(other);
      if (other.inviter === pub && (st === "open" || st === "accepted")) this.#invites.delete(code);
    }
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(this.#rng, CODE_ALPHABET.length)]).join("");
    } while (this.#invites.has(code));
    const inv: Invite = { code, inviter: pub, nonce, expiresAt: this.clock.now() + INVITE_TTL, ...(botInviter ? { botInviter } : {}) };
    this.#invites.set(code, inv);
    return inv;
  }

  #invite(code: string): Invite {
    const inv = this.#invites.get(normalizeCode(code));
    if (!inv) throw new ApiError("unknown-invite", "없는 코드예요. 상대 화면의 코드를 다시 확인해 주세요");
    return inv;
  }

  #status(inv: Invite): InviteView["status"] {
    if (inv.relationshipId) return "done";
    if (inv.error) return "failed";
    if (this.clock.now() > inv.expiresAt) return "expired";
    return inv.acceptor ? "accepted" : "open";
  }

  #view(inv: Invite): InviteView {
    return {
      code: inv.code,
      inviter: inv.inviter,
      nonce: inv.nonce,
      expiresAt: inv.expiresAt,
      status: this.#status(inv),
      ...(inv.acceptor ? { acceptor: inv.acceptor } : {}),
      ...(inv.relationshipId ? { relationshipId: inv.relationshipId } : {}),
      ...(inv.error ? { error: inv.error } : {}),
    };
  }

  /** 두 서명이 다 모였다: 엔진에 관계를 만든다. 실패(상한·중복)는 초대 상태로 돌려준다. */
  #complete(inv: Invite, inviterSignature: string): void {
    const opening = openingOf(inv.inviter, inv.acceptor!, inv.nonce);
    const sigOf = (pub: string) => (pub === inv.inviter ? inviterSignature : inv.acceptorSignature!);
    try {
      inv.relationshipId = this.engine.createRelationship({ opening, sigA: sigOf(opening.a), sigB: sigOf(opening.b) });
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      inv.error = e.message;
      return;
    }
    for (const [self, other] of [
      [inv.inviter, inv.acceptor!],
      [inv.acceptor!, inv.inviter],
    ] as const) {
      const bot = this.#bots.get(self);
      if (!bot) continue;
      bot.member.relationships.set(other, { id: inv.relationshipId, opening });
      // 가상 친구는 35~60일 겪어본 뒤 평가를 등록한다 (숙성된 관계에서 나온 평가가 되도록)
      bot.plans.set(other, { registerAt: this.clock.now() + (35 + randomInt(this.#botRng, 26)) * DAY, written: false, decided: new Set() });
    }
  }

  #requireAccount(pub: string): void {
    if (!this.engine.accountRecord(pub)) throw new ApiError("unknown-account", "등록되지 않은 계정이에요");
  }

  #requireDemo(): void {
    if (!this.demo) throw new ApiError("demo-only", "데모 모드에서만 쓸 수 있어요");
  }

  #newBot(): Bot {
    const member = new Member({ engine: this.engine, timelock: this.timelock, rng: this.#botRng }).join();
    const bot: Bot = { member, plans: new Map() };
    this.#bots.set(member.pub, bot);
    return bot;
  }

  async #botsStep(): Promise<void> {
    const now = this.clock.now();
    for (const bot of this.#bots.values()) {
      for (const [other, plan] of bot.plans) {
        try {
          if (!plan.slotId) {
            if (now >= plan.registerAt) plan.slotId = bot.member.register(other);
            continue;
          }
          if (!plan.written && this.engine.schedule(plan.slotId)) {
            await bot.member.write(plan.slotId, this.#botReview());
            plan.written = true;
          }
          for (const t of bot.member.tasks()) {
            if (t.slotId !== plan.slotId) continue;
            const key = t.kind === "reaffirm" ? `reaffirm:${t.checkpoint}` : "edit";
            if (plan.decided.has(key)) continue;
            plan.decided.add(key);
            if (t.kind === "edit") await bot.member.coverEdit(t.slotId);
            else if (randomFloat(this.#botRng) < 0.85) bot.member.reaffirm(t.slotId, t.checkpoint);
          }
        } catch (e) {
          if (!(e instanceof ProtocolError)) throw e;
          plan.decided.add("failed");
        }
      }
    }
  }

  #botReview(): ReviewContent {
    const endorse = randomFloat(this.#botRng) < 0.8;
    const texts = endorse ? BOT_TEXTS.endorse : BOT_TEXTS.neutral;
    return { stance: endorse ? "endorse" : "neutral", text: texts[randomInt(this.#botRng, texts.length)]! };
  }

  #gcInvites(): void {
    const now = this.clock.now();
    for (const [code, inv] of this.#invites) {
      if (now > inv.expiresAt + INVITE_KEEP) this.#invites.delete(code);
    }
  }
}

function openingOf(x: string, y: string, nonce: string): RelationshipOpening {
  const [a, b] = orderPair(x, y);
  return { a, b, nonce };
}

function sign(member: Member, message: Buffer): string {
  return signMessage(member.keys, message);
}

/** 엔진의 ProtocolError 를 앱 오류로 바꿔 내보낸다. 그 밖의 예외는 그대로 (서버 500). */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ProtocolError) throw new ApiError(e.code, e.message);
    throw e;
  }
}
