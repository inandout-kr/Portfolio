import { DAY, HOUR, MONTH, WEEK, YEAR } from "./time.js";

export interface MukeunjiConfig {
  /** 규칙 4: 숙성된 관계의 봉인 풀린 평가가 n 개 모이면 묶음 공개. */
  readonly batchSize: number;
  /** 규칙 10: 서로 다른 관계 k 개가 경고해야 공개. */
  readonly warningThreshold: number;
  /** 규칙 2: 공개 지연 범위. */
  readonly minDelay: number;
  readonly maxDelay: number;
  /** 규칙 3: 공개 전 수정 창. */
  readonly editWindow: number;
  /** 규칙 6: 등록 시점에 이만큼 묵은 관계여야 n 에 센다. */
  readonly minRelationshipAge: number;
  /** 규칙 11: 이 기간 넘게 묶음이 안 차면 원문 대신 집계만 공개 (재확인 결과 버퍼에도 같은 상한). */
  readonly aggregateAfter: number;
  /** 규칙 7: 공개 후 재확인 시점들. */
  readonly reaffirmCheckpoints: readonly number[];
  readonly reaffirmResponseWindow: number;
  /** 규칙 9: 계정·관계 나이가 이 값에 이르러야 숙성도 만점. */
  readonly maturityFullAge: number;
  /** 규칙 9: 재확인 단계별 가중치 배수. 길이 = 체크포인트 수 + 1. */
  readonly reaffirmBonus: readonly number[];
  /** 가짜 계정 공장 방어: 계정당 주간 신규 관계 상한. */
  readonly maxNewRelationshipsPerWeek: number;
  /** 규칙 5: 리뷰 사건과 무관한 고정 달력 주기로만 시간 기반 점수를 갱신한다. */
  readonly profileRefreshPeriod: number;
  readonly maxTextLength: number;
}

export const DEFAULT_CONFIG: MukeunjiConfig = Object.freeze({
  batchSize: 4,
  warningThreshold: 3,
  minDelay: WEEK,
  maxDelay: 3 * MONTH,
  editWindow: 48 * HOUR,
  minRelationshipAge: 30 * DAY,
  aggregateAfter: 6 * MONTH,
  reaffirmCheckpoints: Object.freeze([YEAR, 3 * YEAR]),
  reaffirmResponseWindow: 30 * DAY,
  maturityFullAge: 2 * YEAR,
  reaffirmBonus: Object.freeze([1, 2, 3]),
  maxNewRelationshipsPerWeek: 10,
  profileRefreshPeriod: 30 * DAY,
  maxTextLength: 1_000,
});

export function resolveConfig(overrides: Partial<MukeunjiConfig> = {}): MukeunjiConfig {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  if (cfg.batchSize < 2) throw new RangeError("batchSize 는 2 이상 (1 이면 익명 집합이 없다)");
  if (cfg.warningThreshold < 2) throw new RangeError("warningThreshold 는 2 이상");
  if (!(cfg.minDelay > cfg.editWindow && cfg.maxDelay >= cfg.minDelay)) {
    throw new RangeError("minDelay 는 editWindow 보다 길고 maxDelay 이하여야 한다");
  }
  if (cfg.reaffirmBonus.length !== cfg.reaffirmCheckpoints.length + 1) {
    throw new RangeError("reaffirmBonus 길이 = 체크포인트 수 + 1");
  }
  return Object.freeze(cfg);
}
