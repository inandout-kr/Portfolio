// 규칙 9: 가중치 = 보증인 자신의 숙성도 × 관계 나이 × 재확인 보너스.
// 숙성도는 제곱 곡선이라 초반엔 아주 느리게 오른다: 1개월 0.002, 6개월 0.06, 1년 0.25, 2년 1.

import type { MukeunjiConfig } from "./config.js";

export function maturity(ageMs: number, fullAgeMs: number): number {
  if (ageMs <= 0) return 0;
  const x = Math.min(1, ageMs / fullAgeMs);
  return x * x;
}

/**
 * 보증인이 스스로 받은 신뢰(S)를 0.2~1 배수로 바꾼다.
 * 바닥 0.2: 아무에게도 지지받지 못한 계정(공장에서 찍은 계정이 전형)의 보증은 1/5 만 쳐준다.
 */
export function standingFactor(received: number): number {
  return 0.2 + 0.8 * (1 - Math.exp(-received));
}

/** 보증인 신뢰도(standing) 계산에 쓰는 1단계 가중치. 재귀를 끊으려고 standing 항이 없다. */
export function baseWeight(accountAge: number, relationshipAge: number, level: number, cfg: MukeunjiConfig): number {
  const bonus = cfg.reaffirmBonus[level];
  if (bonus === undefined) throw new RangeError(`재확인 단계 ${level} 이 없다`);
  return maturity(accountAge, cfg.maturityFullAge) * maturity(relationshipAge, cfg.maturityFullAge) * bonus;
}

export interface WeightInputs {
  /** 보증인 계정 나이 (공증 시각 기준). */
  readonly accountAge: number;
  /** 보증인이 받은 공개된 지지들의 baseWeight 합. */
  readonly received: number;
  /** 보증한 순간(등록 또는 마지막 재확인)의 관계 나이. 공증 시각 기준. */
  readonly relationshipAge: number;
  /** 공개된 재확인 단계 (0 = 아직 재확인 없음). */
  readonly level: number;
}

export function endorsementWeight(w: WeightInputs, cfg: MukeunjiConfig): number {
  return baseWeight(w.accountAge, w.relationshipAge, w.level, cfg) * standingFactor(w.received);
}
