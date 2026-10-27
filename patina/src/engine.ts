// 파티나 프로토콜 엔진 (운영자 노드). 규칙 1~12 를 한 곳에서 집행한다.
//
// 데이터 흐름:
//   관계(상호서명, 해시+공증시각) → 평가 등록(관계당 1회) → 다음 비콘 라운드로 지연 확정(1주~3개월)
//   → 타임락 봉인 → 공개 전 48시간 수정 창 → 봉인 해제
//   → [warn] 경고 에스크로 → 서로 다른 관계 k 개면 공개
//   → [endorse/neutral] 대상별 풀 → 숙성된 관계 평가 n 개면 섞어서 묶음 공개 / 6개월 넘으면 집계만
//   → 지지는 1년·3년 재확인 → 결과도 n 개씩 묶어서 반영 → 리텐션 커브·점수
//
// 대상(받는 사람)과 제3자가 볼 수 있는 건 view() 하나뿐이고, view 는 공개 사건(묶음·집계·경고·재확인 묶음)
// 또는 리뷰와 무관한 고정 달력 주기에만 다시 계산된다. 그래서 개별 평가의 도착·해제는 어떤 출력에도 흔적이 없다.

import { BeaconNotReadyError, firstRoundAtOrAfter, type Beacon } from "./beacon.js";
import { resolveConfig, type PatinaConfig } from "./config.js";
import { fromHex, hex, hmac, sha256, shuffle, systemRandom, verifyMessage, type Bytes, type RandomSource } from "./crypto.js";
import { MembershipError, TransparentMembership, type MembershipVerifier, type ReviewRegistration } from "./membership.js";
import {
  DOMAIN,
  decodeContent,
  relationshipCommitment,
  signedMessage,
  type RelationshipOpening,
  type ReviewContent,
} from "./messages.js";
import type { TimeNotary } from "./notary.js";
import { WEEK, type Clock } from "./time.js";
import type { SealedBox, Timelock } from "./timelock.js";
import { durationLabel, emptyView, type ProfileView, type PublishedItem, type RetentionPoint, type ReviewerTask } from "./views.js";
import { baseWeight, endorsementWeight } from "./weights.js";

export type ProtocolErrorCode =
  | "bad-request"
  | "unknown-account"
  | "duplicate"
  | "self-relationship"
  | "rate-limited"
  | "unknown-relationship"
  | "not-a-party"
  | "bad-signature"
  | "already-registered"
  | "unknown-slot"
  | "not-scheduled"
  | "wrong-round"
  | "edit-window-closed"
  | "revealed"
  | "no-prompt";

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface Handshake {
  readonly opening: RelationshipOpening;
  /** opening.a 의 서명, opening.b 의 서명. 둘 다 있어야 관계가 생긴다 (규칙 1). */
  readonly sigA: string;
  readonly sigB: string;
}

/** 모든 쓰기 응답은 이 값 하나다. 진짜 수정과 위장 수정, 반영과 무시를 구분할 영수증이 없다 (규칙 3). */
export interface Ack {
  readonly ok: true;
}
const ACK: Ack = Object.freeze({ ok: true as const });
const NOT_READY = Symbol("beacon-not-ready");

export interface Schedule {
  readonly revealRound: number;
  /** 봉인이 풀리는 시각 (= revealRound 의 비콘 시각). */
  readonly revealAt: number;
  readonly editOpensAt: number;
}

export interface EngineDeps {
  readonly clock: Clock;
  readonly beacon: Beacon;
  readonly timelock: Timelock;
  readonly notary: TimeNotary;
  readonly membership?: MembershipVerifier;
  /** 묶음 셔플·슬롯 id 용. */
  readonly rng?: RandomSource;
  /** 같은 쌍의 중복 관계를 막는 태그용 비밀. 공개 해시로 두면 누구나 (A,B) 쌍 존재를 조회할 수 있다. */
  readonly operatorSecret?: Bytes;
  readonly config?: Partial<PatinaConfig>;
}

interface Slot {
  readonly slotId: string;
  readonly nullifier: string;
  readonly relationshipId: string;
  readonly reviewer: string;
  readonly subject: string;
  readonly registeredAt: number;
  /** 지연을 정하는 비콘 라운드. 등록 시각 이후 라운드라 등록 전엔 아무도 그 값을 모른다 (규칙 2). */
  readonly delayRound: number;
  /** 등록 시점에 관계가 숙성돼 있었나 (규칙 6). */
  readonly eligible: boolean;
  schedule?: Schedule;
  box?: SealedBox;
  status: "registered" | "scheduled" | "revealed" | "abandoned";
}

interface PoolItem {
  readonly slot: Slot;
  readonly stance: "endorse" | "neutral";
  readonly text: string;
  readonly unsealedAt: number;
}

interface Endorsement {
  readonly slot: Slot;
  readonly revealAt: number;
  // 실제 상태 (평가자 응답에 따라 즉시 바뀜)
  level: number;
  alive: boolean;
  next: number;
  prompt?: { readonly checkpoint: number; readonly deadline: number };
  // 공개 상태 (결과 묶음이 반영될 때만 바뀜, 규칙 5)
  shownLevel: number;
  shownAlive: boolean;
  /** 마지막으로 이 보증을 확인한 시각 (등록 또는 재확인). 가중치의 관계 나이는 이 시점 기준. */
  shownAffirmedAt: number;
}

interface Outcome {
  readonly e: Endorsement;
  readonly checkpoint: number;
  readonly kept: boolean;
  readonly at: number;
}

interface SubjectState {
  // 비공개 대기열
  pool: PoolItem[];
  escrow: Slot[];
  escrowTexts: string[];
  outcomes: Outcome[];
  // 공개된 것
  readonly batches: PublishedItem[][];
  readonly aggregates: { endorse: number; neutral: number }[];
  readonly warnings: string[][];
  readonly disclosedWarners: Slot[];
  readonly endorsements: Endorsement[];
  releasedEndorse: number;
  releasedNeutral: number;
  readonly applied: { kept: number; total: number }[];
  view: ProfileView;
}

export class PatinaEngine {
  readonly config: PatinaConfig;
  readonly #clock: Clock;
  readonly #beacon: Beacon;
  readonly #timelock: Timelock;
  readonly #notary: TimeNotary;
  readonly #membership: MembershipVerifier;
  readonly #rng: RandomSource;
  readonly #operatorSecret: Buffer;

  readonly #accounts = new Map<string, Buffer>(); // pub → 공증 잎
  readonly #relationships = new Set<string>(); // commitment 만
  readonly #pairTags = new Set<string>();
  readonly #recentCreations = new Map<string, number[]>();
  readonly #nullifiers = new Set<string>();
  readonly #slots = new Map<string, Slot>();
  readonly #endorsementBySlot = new Map<string, Endorsement>();
  readonly #subjects = new Map<string, SubjectState>();
  readonly #curveLabels: readonly string[];
  #refreshEpoch = -1;

  constructor(deps: EngineDeps) {
    this.config = resolveConfig(deps.config);
    this.#clock = deps.clock;
    this.#beacon = deps.beacon;
    this.#timelock = deps.timelock;
    this.#notary = deps.notary;
    this.#membership = deps.membership ?? new TransparentMembership();
    this.#rng = deps.rng ?? systemRandom;
    this.#operatorSecret = Buffer.from(deps.operatorSecret ?? this.#rng.bytes(32));
    this.#curveLabels = [durationLabel(this.config.maxDelay), ...this.config.reaffirmCheckpoints.map(durationLabel)];
  }

  // ============================================================ 계정 · 관계 (규칙 1)

  registerAccount(pub: string): void {
    if (!/^[0-9a-f]{64}$/.test(pub)) throw new ProtocolError("bad-request", "공개키 형식이 아니다");
    if (this.#accounts.has(pub)) throw new ProtocolError("duplicate", "이미 있는 계정");
    const leaf = sha256(`${DOMAIN}/account`, pub);
    this.#accounts.set(pub, leaf);
    this.#notary.submit(leaf);
  }

  createRelationship(h: Handshake): string {
    const { a, b, nonce } = h.opening;
    if (a === b) throw new ProtocolError("self-relationship", "자기 자신과는 관계를 맺을 수 없다");
    if (!(a < b) || !/^[0-9a-f]{64}$/.test(nonce)) throw new ProtocolError("bad-request", "opening 형식이 틀렸다");
    if (!this.#accounts.has(a) || !this.#accounts.has(b)) throw new ProtocolError("unknown-account", "등록 안 된 계정");
    const id = relationshipCommitment(h.opening);
    const m = signedMessage.handshake(id);
    if (!verifyMessage(a, m, h.sigA) || !verifyMessage(b, m, h.sigB)) {
      throw new ProtocolError("bad-signature", "두 사람 모두 서명해야 관계가 생긴다");
    }
    const pairTag = hex(hmac(this.#operatorSecret, "pair", a, b));
    if (this.#pairTags.has(pairTag)) throw new ProtocolError("duplicate", "같은 두 사람의 관계는 하나뿐이다");
    const now = this.#clock.now();
    for (const p of [a, b]) {
      if (this.#recentFor(p, now).length >= this.config.maxNewRelationshipsPerWeek) {
        throw new ProtocolError("rate-limited", "이번 주 신규 관계 상한에 걸렸다");
      }
    }
    this.#pairTags.add(pairTag);
    for (const p of [a, b]) this.#recentFor(p, now).push(now);
    this.#relationships.add(id);
    this.#notary.submit(fromHex(id));
    return id;
  }

  /** 엔진이 관계에 대해 아는 전부: 해시와 공증 시각. */
  relationshipRecord(id: string): { readonly id: string; readonly anchoredAt: number | null } | undefined {
    if (!this.#relationships.has(id)) return undefined;
    return { id, anchoredAt: this.#notary.anchoredAt(fromHex(id)) ?? null };
  }

  // ============================================================ 평가 등록 · 봉인 · 수정 (규칙 2, 3)

  registerReview(reg: ReviewRegistration): { readonly slotId: string } {
    let v;
    try {
      v = this.#membership.verify(reg, (id) => this.#relationships.has(id));
    } catch (e) {
      if (e instanceof MembershipError) throw new ProtocolError(e.code, e.message);
      throw e;
    }
    if (this.#nullifiers.has(v.nullifier)) throw new ProtocolError("already-registered", "관계당 평가는 한 번, 취소도 없다");
    const now = this.#clock.now();
    const slot: Slot = {
      slotId: hex(this.#rng.bytes(16)),
      nullifier: v.nullifier,
      relationshipId: v.relationshipId,
      reviewer: v.reviewer,
      subject: v.subject,
      registeredAt: now,
      delayRound: this.#beacon.roundAt(now) + 1,
      eligible: this.#relationshipAge(v.relationshipId, now) >= this.config.minRelationshipAge,
      status: "registered",
    };
    this.#nullifiers.add(v.nullifier);
    this.#slots.set(slot.slotId, slot);
    this.#notary.submit(sha256(`${DOMAIN}/registration`, v.nullifier));
    return { slotId: slot.slotId };
  }

  /** 평가자 전용 (slotId 는 작성자만 아는 능력값). 지연이 아직 안 정해졌으면 undefined. */
  schedule(slotId: string): Schedule | undefined {
    return this.#slots.get(slotId)?.schedule;
  }

  /**
   * 봉인된 평가 제출. 첫 제출은 지연 확정 뒤 언제든, 그 뒤 교체는 공개 전 수정 창에서만, 몇 번이든.
   * 엔진은 마지막 상자만 들고 있고 이력·횟수는 남기지 않는다.
   */
  submitSealed(slotId: string, box: SealedBox, signature: string): Ack {
    const slot = this.#slots.get(slotId);
    if (!slot) throw new ProtocolError("unknown-slot", "없는 슬롯");
    if (slot.status === "registered" || !slot.schedule) throw new ProtocolError("not-scheduled", "공개 지연이 아직 안 정해졌다");
    if (slot.status !== "scheduled") throw new ProtocolError("revealed", "이미 공개됐다");
    if (box.round !== slot.schedule.revealRound) throw new ProtocolError("wrong-round", "정해진 공개 라운드로만 봉인할 수 있다");
    if (!verifyMessage(slot.reviewer, signedMessage.seal(slotId, box.round, box.ciphertext), signature)) {
      throw new ProtocolError("bad-signature", "작성자 서명이 아니다");
    }
    const now = this.#clock.now();
    if (now >= slot.schedule.revealAt) throw new ProtocolError("revealed", "이미 공개 시각이 지났다");
    if (slot.box && now < slot.schedule.editOpensAt) {
      throw new ProtocolError("edit-window-closed", "수정은 공개 전 수정 창에서만 할 수 있다");
    }
    slot.box = { round: box.round, ciphertext: Buffer.from(box.ciphertext) };
    return ACK;
  }

  // ============================================================ 재확인 (규칙 7)

  reaffirm(slotId: string, checkpoint: number, signature: string): Ack {
    const e = this.#endorsementBySlot.get(slotId);
    const now = this.#clock.now();
    if (!e?.prompt || e.prompt.checkpoint !== checkpoint || now > e.prompt.deadline) {
      throw new ProtocolError("no-prompt", "지금 열린 재확인 요청이 없다");
    }
    if (!verifyMessage(e.slot.reviewer, signedMessage.reaffirm(slotId, checkpoint), signature)) {
      throw new ProtocolError("bad-signature", "작성자 서명이 아니다");
    }
    e.level += 1;
    e.next += 1;
    e.prompt = undefined;
    this.#state(e.slot.subject).outcomes.push({ e, checkpoint, kept: true, at: now });
    return ACK;
  }

  reviewerTasks(slotIds: readonly string[]): ReviewerTask[] {
    const now = this.#clock.now();
    const tasks: ReviewerTask[] = [];
    for (const slotId of slotIds) {
      const slot = this.#slots.get(slotId);
      const s = slot?.schedule;
      if (slot?.status === "scheduled" && s && now >= s.editOpensAt && now < s.revealAt) {
        tasks.push({ kind: "edit", slotId, opensAt: s.editOpensAt, closesAt: s.revealAt });
      }
      const p = this.#endorsementBySlot.get(slotId)?.prompt;
      if (p && now <= p.deadline) {
        tasks.push({ kind: "reaffirm", slotId, checkpoint: p.checkpoint, label: this.#curveLabels[p.checkpoint + 1]!, deadline: p.deadline });
      }
    }
    return tasks;
  }

  // ============================================================ 공개 화면 (규칙 4, 5, 8, 10, 11)

  /** 대상 본인과 제3자가 보는 유일한 화면. 대기 개수·도착 알림 같은 필드는 처음부터 없다. */
  view(subject: string): ProfileView {
    return this.#subjects.get(subject)?.view ?? deepFreeze(emptyView(subject, this.#curveLabels));
  }

  // ============================================================ 시간 진행

  /** 시계가 움직인 뒤 호출한다. 하루 한 번이면 충분하고, 더 자주 불러도 결과는 같다. */
  async tick(): Promise<void> {
    const now = this.#clock.now();
    const cfg = this.config;
    await this.#notary.flush();
    const touched = new Set<string>();

    // 1) 지연 확정: 등록 이후 라운드의 비콘 값으로만 정한다 (규칙 2).
    for (const slot of this.#slots.values()) {
      if (slot.status !== "registered" || this.#beacon.timeOfRound(slot.delayRound) > now) continue;
      let rnd: Buffer;
      try {
        rnd = await this.#beacon.randomness(slot.delayRound);
      } catch (e) {
        if (e instanceof BeaconNotReadyError) continue; // 실제 비콘은 늦게 도착할 수 있다: 다음 tick 에 다시
        throw e;
      }
      const span = cfg.maxDelay - cfg.minDelay;
      const u = sha256(`${DOMAIN}/delay`, rnd, slot.nullifier).readUIntBE(0, 6);
      const revealRound = firstRoundAtOrAfter(this.#beacon, slot.registeredAt + cfg.minDelay + (u % (span + 1)));
      const revealAt = this.#beacon.timeOfRound(revealRound);
      slot.schedule = { revealRound, revealAt, editOpensAt: revealAt - cfg.editWindow };
      slot.status = "scheduled";
    }

    // 2) 봉인 해제: warn 은 에스크로, 나머지는 대상별 풀로. 안 쓴 슬롯은 그냥 사라진다.
    for (const slot of this.#slots.values()) {
      if (slot.status !== "scheduled" || now < slot.schedule!.revealAt) continue;
      const content = slot.box ? await this.#openContent(slot.box) : null;
      if (content === NOT_READY) continue;
      slot.box = undefined;
      if (!content) {
        slot.status = "abandoned";
        continue;
      }
      slot.status = "revealed";
      const st = this.#state(slot.subject);
      if (content.stance === "warn") {
        st.escrow.push(slot);
        st.escrowTexts.push(content.text);
      } else {
        st.pool.push({ slot, stance: content.stance, text: content.text, unsealedAt: now });
      }
    }

    for (const [subject, st] of this.#subjects) {
      // 3) 경고: 서로 다른 관계 k 개가 모일 때만, 그 묶음째로 공개 (규칙 10).
      if (new Set(st.escrow.map((s) => s.relationshipId)).size >= cfg.warningThreshold) {
        st.warnings.push(shuffle(st.escrowTexts, this.#rng));
        st.disclosedWarners.push(...st.escrow);
        st.escrow = [];
        st.escrowTexts = [];
        touched.add(subject);
      }

      // 4) 묶음 공개: 숙성된 관계 평가가 n 개 모이면 풀 전체를 섞어서 (규칙 4, 6).
      //    6개월 넘게 안 차면 원문은 버리고 집계만 (규칙 11).
      if (st.pool.length > 0) {
        const eligible = st.pool.filter((p) => p.slot.eligible).length;
        if (eligible >= cfg.batchSize) {
          st.batches.push(shuffle(st.pool.map((p) => ({ stance: p.stance, text: p.text })), this.#rng));
          this.#release(st);
          touched.add(subject);
        } else if (Math.min(...st.pool.map((p) => p.unsealedAt)) + cfg.aggregateAfter <= now) {
          st.aggregates.push({
            endorse: st.pool.filter((p) => p.stance === "endorse").length,
            neutral: st.pool.filter((p) => p.stance === "neutral").length,
          });
          this.#release(st);
          touched.add(subject);
        }
      }
    }

    // 5) 재확인 체크포인트 (규칙 7). 1년에 소멸한 지지는 3년 지점에서 자동으로 '유지 안 됨' 결과를 낸다.
    for (const e of this.#endorsementBySlot.values()) {
      while (e.next < cfg.reaffirmCheckpoints.length) {
        const due = e.revealAt + cfg.reaffirmCheckpoints[e.next]!;
        if (now < due) break;
        if (!e.alive) {
          this.#state(e.slot.subject).outcomes.push({ e, checkpoint: e.next, kept: false, at: now });
          e.next += 1;
          continue;
        }
        if (!e.prompt) {
          e.prompt = { checkpoint: e.next, deadline: due + cfg.reaffirmResponseWindow };
          break;
        }
        if (now <= e.prompt.deadline) break;
        e.alive = false;
        e.prompt = undefined;
        this.#state(e.slot.subject).outcomes.push({ e, checkpoint: e.next, kept: false, at: now });
        e.next += 1;
      }
    }

    // 6) 재확인 결과도 n 개씩 묶어서만 공개 상태에 반영 (규칙 5). 상한은 6개월.
    for (const [subject, st] of this.#subjects) {
      if (st.outcomes.length === 0) continue;
      const oldest = Math.min(...st.outcomes.map((o) => o.at));
      if (st.outcomes.length < cfg.batchSize && oldest + cfg.aggregateAfter > now) continue;
      for (const o of st.outcomes) {
        const a = st.applied[o.checkpoint]!;
        a.total += 1;
        if (o.kept) {
          a.kept += 1;
          o.e.shownLevel = o.checkpoint + 1;
          o.e.shownAffirmedAt = o.at;
        } else {
          o.e.shownAlive = false;
        }
      }
      st.outcomes = [];
      touched.add(subject);
    }

    // 7) 시간 기반 점수(나이가 들수록 오르는 가중치)는 리뷰 사건과 무관한 고정 달력 주기에만 갱신.
    const epoch = Math.floor(now / cfg.profileRefreshPeriod);
    if (epoch !== this.#refreshEpoch) {
      this.#refreshEpoch = epoch;
      for (const subject of this.#subjects.keys()) touched.add(subject);
    }
    for (const subject of touched) this.#state(subject).view = this.#computeView(subject, now);
  }

  // ============================================================ 내부

  /**
   * 봉인은 해제 전엔 검사할 수 없어서, 서명은 맞는데 내용이 깨진 상자도 들어올 수 있다. 그건 안 쓴 것(null)으로 친다.
   * 비콘 라운드가 아직 안 들어왔으면 NOT_READY: 다음 tick 에 다시 연다.
   */
  async #openContent(box: SealedBox): Promise<ReviewContent | null | typeof NOT_READY> {
    let plaintext: Buffer;
    try {
      plaintext = await this.#timelock.open(box);
    } catch (e) {
      if (e instanceof BeaconNotReadyError) return NOT_READY;
      return null;
    }
    return decodeContent(plaintext, this.config.maxTextLength);
  }

  #recentFor(pub: string, now: number): number[] {
    const list = (this.#recentCreations.get(pub) ?? []).filter((t) => t > now - WEEK);
    this.#recentCreations.set(pub, list);
    return list;
  }

  #accountAge(pub: string, at: number): number {
    const leaf = this.#accounts.get(pub);
    const t = leaf && this.#notary.anchoredAt(leaf);
    return t === undefined ? 0 : Math.max(0, at - t);
  }

  /** at 시점의 관계 나이. 공증 시각 기준이고, at 에 아직 체인에 없었으면 0 (주장된 시각은 쓰지 않는다). */
  #relationshipAge(id: string, at: number): number {
    const t = this.#notary.anchoredAt(fromHex(id));
    return t === undefined ? 0 : Math.max(0, at - t);
  }

  #state(subject: string): SubjectState {
    let st = this.#subjects.get(subject);
    if (!st) {
      st = {
        pool: [],
        escrow: [],
        escrowTexts: [],
        outcomes: [],
        batches: [],
        aggregates: [],
        warnings: [],
        disclosedWarners: [],
        endorsements: [],
        releasedEndorse: 0,
        releasedNeutral: 0,
        applied: this.config.reaffirmCheckpoints.map(() => ({ kept: 0, total: 0 })),
        view: deepFreeze(emptyView(subject, this.#curveLabels)),
      };
      this.#subjects.set(subject, st);
    }
    return st;
  }

  #release(st: SubjectState): void {
    for (const p of st.pool) {
      if (p.stance === "neutral") {
        st.releasedNeutral += 1;
        continue;
      }
      st.releasedEndorse += 1;
      const e: Endorsement = {
        slot: p.slot,
        revealAt: p.slot.schedule!.revealAt,
        level: 0,
        alive: true,
        next: 0,
        shownLevel: 0,
        shownAlive: true,
        shownAffirmedAt: p.slot.registeredAt,
      };
      st.endorsements.push(e);
      this.#endorsementBySlot.set(p.slot.slotId, e);
    }
    st.pool = [];
  }

  /** 공개 상태만으로 계산한다. 대기열(pool·escrow·outcomes)은 읽지 않는다. */
  #computeView(subject: string, now: number): ProfileView {
    const st = this.#state(subject);
    // 관계 나이는 "보증한 순간" 기준: 만난 첫날 쓴 보증은 무게가 0이고, 1년 뒤 재확인을 견뎌야 무거워진다.
    const weightOf = (s: Slot, level: number, affirmedAt: number): number =>
      endorsementWeight(
        {
          accountAge: this.#accountAge(s.reviewer, now),
          received: this.#received(s.reviewer, now),
          relationshipAge: this.#relationshipAge(s.relationshipId, affirmedAt),
          level,
        },
        this.config,
      );
    let score = 0;
    for (const e of st.endorsements) if (e.shownAlive) score += weightOf(e.slot, e.shownLevel, e.shownAffirmedAt);
    // 경고는 재확인이 없어서 관계 나이를 지금 기준으로 잰다. 피해는 보통 짧은 관계에서 생기므로
    // 등록 시점으로 재면 공개된 경고가 거의 무게가 없다. 공증된 시간이라 바람잡이도 수년이 든다.
    for (const s of st.disclosedWarners) score -= weightOf(s, 0, now);

    const point = (label: string, kept: number, total: number): RetentionPoint => ({
      label,
      kept,
      total,
      rate: total === 0 ? null : kept / total,
    });
    const curve = [
      point(this.#curveLabels[0]!, st.releasedEndorse, st.releasedEndorse + st.releasedNeutral),
      ...st.applied.map((a, i) => point(this.#curveLabels[i + 1]!, a.kept, a.total)),
    ];
    return deepFreeze({
      subject,
      score,
      curve,
      batches: st.batches.map((b) => b.map((i) => ({ ...i }))),
      aggregates: st.aggregates.map((a) => ({ ...a })),
      warnings: st.warnings.map((w) => [...w]),
    });
  }

  /** 보증인이 받은 공개된 지지의 1단계 가중치 합 (standing 의 재료). */
  #received(pub: string, now: number): number {
    const st = this.#subjects.get(pub);
    if (!st) return 0;
    let sum = 0;
    for (const e of st.endorsements) {
      if (!e.shownAlive) continue;
      sum += baseWeight(
        this.#accountAge(e.slot.reviewer, now),
        this.#relationshipAge(e.slot.relationshipId, e.shownAffirmedAt),
        e.shownLevel,
        this.config,
      );
    }
    return sum;
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
