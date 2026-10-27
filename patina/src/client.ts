// 사용자 쪽 클라이언트. 키·관계 opening·슬롯 id(능력값)·작성 내용은 전부 여기에만 있다.
// 엔진은 봉인된 상자만 받는다.

import { generateKeyPair, hex, signMessage, systemRandom, type KeyPair, type RandomSource } from "./crypto.js";
import type { Ack, PatinaEngine } from "./engine.js";
import {
  encodeContent,
  orderPair,
  relationshipCommitment,
  signedMessage,
  type RelationshipOpening,
  type ReviewContent,
} from "./messages.js";
import type { Timelock } from "./timelock.js";
import type { ReviewerTask } from "./views.js";

export interface MemberDeps {
  readonly engine: PatinaEngine;
  readonly timelock: Timelock;
  readonly rng?: RandomSource;
  readonly keys?: KeyPair;
}

export class Member {
  readonly keys: KeyPair;
  /** 상대 공개키 → 관계 (내 기기에만 있는 opening 포함). */
  readonly relationships = new Map<string, { readonly id: string; readonly opening: RelationshipOpening }>();
  readonly #engine: PatinaEngine;
  readonly #timelock: Timelock;
  readonly #rng: RandomSource;
  /** slotId(나만 아는 능력값) → 마지막으로 봉인한 내용. */
  readonly #drafts = new Map<string, { content?: ReviewContent }>();

  constructor(deps: MemberDeps) {
    this.#engine = deps.engine;
    this.#timelock = deps.timelock;
    this.#rng = deps.rng ?? systemRandom;
    this.keys = deps.keys ?? generateKeyPair(this.#rng);
  }

  get pub(): string {
    return this.keys.publicKey;
  }

  join(): this {
    this.#engine.registerAccount(this.pub);
    return this;
  }

  /** 대면 QR/NFC 핸드셰이크에 해당: 두 기기가 같은 commitment 에 각자 서명한다. */
  static befriend(x: Member, y: Member): string {
    const [a, b] = orderPair(x.pub, y.pub);
    const opening: RelationshipOpening = { a, b, nonce: hex(x.#rng.bytes(32)) };
    const id = relationshipCommitment(opening);
    const sig = (m: Member) => signMessage(m.keys, signedMessage.handshake(id));
    const [ma, mb] = a === x.pub ? [x, y] : [y, x];
    x.#engine.createRelationship({ opening, sigA: sig(ma), sigB: sig(mb) });
    x.relationships.set(y.pub, { id, opening });
    y.relationships.set(x.pub, { id, opening });
    return id;
  }

  /** 평가 자리를 잡는다 (관계당 1회, 취소 불가). 돌려받는 slotId 는 나만 아는 값이다. */
  register(counterparty: string): string {
    const rel = this.relationships.get(counterparty);
    if (!rel) throw new Error("관계가 없는 상대");
    const { slotId } = this.#engine.registerReview({
      relationshipId: rel.id,
      opening: rel.opening,
      reviewer: this.pub,
      signature: signMessage(this.keys, signedMessage.register(rel.id, this.pub)),
    });
    this.#drafts.set(slotId, {});
    return slotId;
  }

  /** 지연이 확정된 뒤 내용을 공개 라운드로 봉인해 제출한다. 수정 창에서 다시 부르면 수정이다. */
  async write(slotId: string, content: ReviewContent): Promise<Ack> {
    const draft = this.#drafts.get(slotId);
    const schedule = this.#engine.schedule(slotId);
    if (!draft || !schedule) throw new Error("아직 공개 지연이 정해지지 않았다");
    const box = await this.#timelock.seal(encodeContent(content), schedule.revealRound);
    const ack = this.#engine.submitSealed(slotId, box, signMessage(this.keys, signedMessage.seal(slotId, box.round, box.ciphertext)));
    draft.content = content;
    return ack;
  }

  /**
   * 내용은 그대로 두고 새로 봉인해서 다시 낸다. 상자는 매번 새 암호문이라
   * 밖에서 보면 진짜 수정과 똑같다. 클라이언트는 수정 창마다 이걸 기본으로 한 번 보낸다.
   */
  async coverEdit(slotId: string): Promise<Ack> {
    const content = this.#drafts.get(slotId)?.content;
    if (!content) throw new Error("봉인한 내용이 없다");
    return this.write(slotId, content);
  }

  reaffirm(slotId: string, checkpoint: number): Ack {
    return this.#engine.reaffirm(slotId, checkpoint, signMessage(this.keys, signedMessage.reaffirm(slotId, checkpoint)));
  }

  tasks(): ReviewerTask[] {
    return this.#engine.reviewerTasks([...this.#drafts.keys()]);
  }
}
