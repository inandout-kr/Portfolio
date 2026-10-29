// 서명 대상 메시지와 평가 내용 인코딩. 클라이언트와 엔진이 같은 바이트를 만들도록 한 곳에 둔다.

import { hex, sha256, type Bytes } from "./crypto.js";

export const DOMAIN = "patina/v1";

/** 관계를 여는 값. 체인/엔진에는 이걸 해시한 commitment 만 남는다 (규칙 1). */
export interface RelationshipOpening {
  /** a < b 사전순. 같은 쌍이 늘 같은 순서로 인코딩되게 한다. */
  readonly a: string;
  readonly b: string;
  /** 32바이트 hex. 쌍만 알아서는 commitment 를 역산할 수 없게 한다. */
  readonly nonce: string;
}

export function orderPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

export function relationshipCommitment(o: RelationshipOpening): string {
  return hex(sha256(`${DOMAIN}/rel`, o.a, o.b, o.nonce));
}

export const signedMessage = {
  handshake: (relationshipId: string): Buffer => sha256(`${DOMAIN}/handshake`, relationshipId),
  register: (relationshipId: string, reviewer: string): Buffer => sha256(`${DOMAIN}/register`, relationshipId, reviewer),
  seal: (slotId: string, round: number, ciphertext: Bytes): Buffer => sha256(`${DOMAIN}/seal`, slotId, round, ciphertext),
  reaffirm: (slotId: string, checkpoint: number): Buffer => sha256(`${DOMAIN}/reaffirm`, slotId, checkpoint),
  /** 앱의 초대코드 발급: "이 nonce 로 관계를 열겠다"는 초대한 사람의 서명. */
  invite: (pub: string, nonce: string): Buffer => sha256(`${DOMAIN}/invite`, pub, nonce),
};

/**
 * 두 휴대폰이 같은 관계에 서명하는지 사람이 눈으로 맞춰보는 4자리 숫자 (블루투스 페어링과 같은 방식).
 * 중간에서 누가 공개키를 바꿔치기하면 두 화면의 숫자가 달라진다.
 */
export function verificationDigits(relationshipId: string): string {
  return String(sha256(`${DOMAIN}/verify`, relationshipId).readUInt32BE(0) % 10_000).padStart(4, "0");
}

// ---------------------------------------------------------------- 평가 내용

/** endorse = 믿는다, neutral = 그저 그렇다, warn = 경고 (k 명이 모여야 공개). */
export type Stance = "endorse" | "neutral" | "warn";

export interface ReviewContent {
  readonly stance: Stance;
  readonly text: string;
}

export function encodeContent(c: ReviewContent): Buffer {
  return Buffer.from(JSON.stringify({ stance: c.stance, text: c.text }), "utf8");
}

/** 봉인 상태로 들어와서 형식 검사는 해제 때만 가능하다. 깨진 내용은 null (= 안 쓴 것으로 처리). */
export function decodeContent(b: Bytes, maxTextLength: number): ReviewContent | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(b).toString("utf8"));
    if (typeof v !== "object" || v === null) return null;
    const { stance, text } = v as Record<string, unknown>;
    if (stance !== "endorse" && stance !== "neutral" && stance !== "warn") return null;
    if (typeof text !== "string" || text.length > maxTextLength) return null;
    return { stance, text };
  } catch {
    return null;
  }
}
