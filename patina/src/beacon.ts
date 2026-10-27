// 공개 난수 비콘 (drand 모델). 라운드 r 의 값은 그 라운드 시각이 오기 전엔 누구도 모른다.
// 파티나는 이걸 두 군데 쓴다: (1) 공개 지연을 "등록 이후" 값으로 정해서 시점 고르기를 막고,
// (2) 타임락 봉인의 해제 조건으로 쓴다.

import type { Clock } from "./time.js";
import { hmac, type Bytes } from "./crypto.js";

export interface Beacon {
  readonly genesisTime: number;
  readonly periodMs: number;
  /** time 시점에 이미 공개된 가장 최근 라운드. genesis 이전이면 0. */
  roundAt(time: number): number;
  timeOfRound(round: number): number;
  /** 라운드 값. 그 라운드 시각 전이면 BeaconNotReadyError (실제 drand 처럼 미래 값은 존재하지 않는다). */
  randomness(round: number): Promise<Buffer>;
}

export class BeaconNotReadyError extends Error {
  constructor(readonly round: number) {
    super(`비콘 라운드 ${round} 은 아직 공개되지 않았다`);
    this.name = "BeaconNotReadyError";
  }
}

/**
 * v2 실연동 대상: drand quicknet (2026-10 api.drand.sh/<hash>/info 로 확인한 값).
 * 실제 어댑터는 비동기 폴러가 라운드를 받아 캐시하고, randomness() 는 캐시를 읽는 형태가 된다.
 */
export const DRAND_QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  genesisTime: 1_692_803_367_000,
  periodMs: 3_000,
  schemeID: "bls-unchained-g1-rfc9380",
} as const;

/** drand 라운드 산식: 라운드 1 = genesis, 이후 period 마다 1씩. */
export function roundAtTime(genesisTime: number, periodMs: number, time: number): number {
  if (time < genesisTime) return 0;
  return Math.floor((time - genesisTime) / periodMs) + 1;
}

export function timeOfRoundNumber(genesisTime: number, periodMs: number, round: number): number {
  return genesisTime + (round - 1) * periodMs;
}

/** time 이후(같거나 늦은) 첫 라운드. 봉인 해제가 약속 시각보다 일찍 오지 않게 할 때 쓴다. */
export function firstRoundAtOrAfter(beacon: Beacon, time: number): number {
  const r = beacon.roundAt(time);
  return beacon.timeOfRound(r) >= time ? r : r + 1;
}

/** 키·네트워크 없는 테스트용 비콘. 값은 HMAC(seed, round) 이고 시계로 공개 시점을 강제한다. */
export class MockBeacon implements Beacon {
  readonly genesisTime: number;
  readonly periodMs: number;
  readonly #clock: Clock;
  readonly #seed: Buffer;

  constructor(opts: { clock: Clock; seed: Bytes; genesisTime?: number; periodMs?: number }) {
    this.#clock = opts.clock;
    this.#seed = Buffer.from(opts.seed);
    this.genesisTime = opts.genesisTime ?? DRAND_QUICKNET.genesisTime;
    this.periodMs = opts.periodMs ?? DRAND_QUICKNET.periodMs;
  }

  roundAt(time: number): number {
    return roundAtTime(this.genesisTime, this.periodMs, time);
  }

  timeOfRound(round: number): number {
    return timeOfRoundNumber(this.genesisTime, this.periodMs, round);
  }

  async randomness(round: number): Promise<Buffer> {
    if (round < 1 || this.timeOfRound(round) > this.#clock.now()) throw new BeaconNotReadyError(round);
    return hmac(this.#seed, "patina/mock-beacon", round);
  }
}
