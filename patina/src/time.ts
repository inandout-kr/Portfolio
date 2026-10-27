// 시간 단위와 시계. 파티나에서 시간은 평판의 유일한 재료라서, 모든 시각은
// 주입된 Clock 에서만 읽는다 (테스트/시뮬레이션은 VirtualClock 으로 3년을 몇 초에 돌린다).

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
/** 이 프로젝트에서 1개월 = 30일, 1년 = 365일로 고정한다. */
export const MONTH = 30 * DAY;
export const YEAR = 365 * DAY;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** 앞으로만 가는 가상 시계. 되감기가 가능하면 "시간은 위조 불가"라는 전제가 깨진다. */
export class VirtualClock implements Clock {
  #t: number;

  constructor(start: number) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError("시계는 되돌릴 수 없다");
    this.#t += ms;
  }

  setTo(t: number): void {
    if (t < this.#t) throw new RangeError("시계는 되돌릴 수 없다");
    this.#t = t;
  }
}
