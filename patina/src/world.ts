// 가상 세계: 가상 시계 + 목업 비콘/타임락/체인 + 엔진을 한 번에 엮는다.
// 같은 시드면 키·셔플·지연까지 전부 재현된다 (두 세계를 나란히 돌리는 차분 테스트의 바탕).

import { MockBeacon } from "./beacon.js";
import { Member } from "./client.js";
import type { PatinaConfig } from "./config.js";
import { SeededRandom, sha256 } from "./crypto.js";
import { PatinaEngine } from "./engine.js";
import { InMemoryChain, TimeNotary } from "./notary.js";
import { DAY, VirtualClock } from "./time.js";
import { MockTimelock } from "./timelock.js";

export interface WorldOptions {
  readonly seed?: string;
  /** 비콘만 바꾸고 나머지(키·관계·셔플)는 그대로 두고 싶을 때. */
  readonly beaconSeed?: string;
  /** 기본 2026-11-01 00:00 UTC. */
  readonly start?: number;
  readonly config?: Partial<PatinaConfig>;
}

export class World {
  readonly clock: VirtualClock;
  readonly beacon: MockBeacon;
  readonly timelock: MockTimelock;
  readonly chain: InMemoryChain;
  readonly notary: TimeNotary;
  readonly engine: PatinaEngine;
  readonly #memberRng: SeededRandom;

  constructor(opts: WorldOptions = {}) {
    const seed = opts.seed ?? "patina";
    const rng = (label: string) => new SeededRandom(sha256(seed, label));
    this.clock = new VirtualClock(opts.start ?? Date.UTC(2026, 10, 1));
    this.beacon = new MockBeacon({ clock: this.clock, seed: sha256(opts.beaconSeed ?? seed, "beacon") });
    this.timelock = new MockTimelock(this.beacon, sha256(seed, "tlock-master"), rng("tlock"));
    this.chain = new InMemoryChain(this.clock);
    this.notary = new TimeNotary(this.chain);
    this.engine = new PatinaEngine({
      clock: this.clock,
      beacon: this.beacon,
      timelock: this.timelock,
      notary: this.notary,
      rng: rng("engine"),
      operatorSecret: sha256(seed, "operator"),
      ...(opts.config ? { config: opts.config } : {}),
    });
    this.#memberRng = rng("members");
  }

  /** 새 사용자 (가입까지). */
  member(): Member {
    return new Member({ engine: this.engine, timelock: this.timelock, rng: this.#memberRng }).join();
  }

  tick(): Promise<void> {
    return this.engine.tick();
  }

  /** ms 만큼 시간을 흘리며 step 마다 tick. onTick 은 매 tick 뒤에 불린다 (사용자 반응 시뮬레이션). */
  async advance(ms: number, step = DAY, onTick?: () => unknown): Promise<void> {
    const end = this.clock.now() + ms;
    while (this.clock.now() < end) {
      this.clock.setTo(Math.min(end, this.clock.now() + step));
      await this.engine.tick();
      await onTick?.();
    }
  }

  /** 조건이 참이 될 때까지 step 단위로 흘린다 (상한 limit). */
  async advanceUntil(cond: () => boolean, limit: number, step = DAY): Promise<void> {
    const end = this.clock.now() + limit;
    while (!cond()) {
      if (this.clock.now() >= end) throw new Error("조건이 상한 안에 만족되지 않았다");
      this.clock.setTo(Math.min(end, this.clock.now() + step));
      await this.engine.tick();
    }
  }
}
