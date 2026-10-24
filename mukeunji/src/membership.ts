// 평가 등록 자격 검증. "이 관계의 당사자 중 한 명이, 관계당 한 번" 만 증명하면 된다.
// MVP 는 투명 모드(운영자가 쌍을 본다). v2 에서 Semaphore ZK 증명으로 바꾸면
// 운영자도 평가자가 누구인지 모르고 nullifier 로 1회 제한만 확인한다.

import { hex, sha256, verifyMessage } from "./crypto.js";
import { DOMAIN, relationshipCommitment, signedMessage, type RelationshipOpening } from "./messages.js";

export interface ReviewRegistration {
  readonly relationshipId: string;
  /** 투명 모드 전용. ZK 모드에선 opening 대신 증명이 온다. */
  readonly opening: RelationshipOpening;
  readonly reviewer: string;
  readonly signature: string;
}

export interface VerifiedMembership {
  readonly relationshipId: string;
  readonly reviewer: string;
  readonly subject: string;
  /** 관계·평가자별로 결정적인 값. 같은 사람이 같은 관계로 두 번 등록하면 같은 값이 나온다. */
  readonly nullifier: string;
}

export type MembershipErrorCode = "unknown-relationship" | "not-a-party" | "bad-signature";

export class MembershipError extends Error {
  constructor(
    readonly code: MembershipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MembershipError";
  }
}

/** v2 실연동 대상: Semaphore 그룹(= 대상의 관계 집합) 멤버십 증명 + nullifier. */
export interface MembershipVerifier {
  verify(reg: ReviewRegistration, relationshipExists: (id: string) => boolean): VerifiedMembership;
}

export class TransparentMembership implements MembershipVerifier {
  verify(reg: ReviewRegistration, relationshipExists: (id: string) => boolean): VerifiedMembership {
    if (relationshipCommitment(reg.opening) !== reg.relationshipId || !relationshipExists(reg.relationshipId)) {
      throw new MembershipError("unknown-relationship", "존재하지 않는 관계");
    }
    const { a, b } = reg.opening;
    if (reg.reviewer !== a && reg.reviewer !== b) throw new MembershipError("not-a-party", "관계 당사자가 아니다");
    if (!verifyMessage(reg.reviewer, signedMessage.register(reg.relationshipId, reg.reviewer), reg.signature)) {
      throw new MembershipError("bad-signature", "등록 서명이 틀렸다");
    }
    return {
      relationshipId: reg.relationshipId,
      reviewer: reg.reviewer,
      subject: reg.reviewer === a ? b : a,
      nullifier: hex(sha256(`${DOMAIN}/nullifier`, reg.relationshipId, reg.reviewer)),
    };
  }
}
