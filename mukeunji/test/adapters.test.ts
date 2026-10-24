// v2 연동 준비: 외부 의존(비콘·타임락·체인·멤버십)은 전부 인터페이스라서
// 네트워크처럼 늦게 응답하는 구현으로 바꿔 끼워도 엔진 결과가 같아야 한다.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import {
  BeaconNotReadyError,
  DAY,
  InMemoryChain,
  Member,
  MockBeacon,
  MockTimelock,
  MukeunjiEngine,
  ProtocolError,
  SeededRandom,
  TimeNotary,
  TransparentMembership,
  VirtualClock,
  sha256,
  type Beacon,
  type ChainNotary,
  type MembershipVerifier,
  type ProfileView,
  type Timelock,
} from "../src/index.js";
import { endorse } from "./helpers.js";

/** 매 호출마다 이벤트 루프를 몇 번 돌려서 실제 네트워크 지연을 흉내 낸다. */
const slow = async <T>(f: () => Promise<T>): Promise<T> => {
  for (let i = 0; i < 3; i++) await tick();
  return f();
};

function build(opts: { slowAdapters: boolean; membership?: MembershipVerifier }) {
  const clock = new VirtualClock(Date.UTC(2026, 10, 1));
  const mockBeacon = new MockBeacon({ clock, seed: sha256("adapters", "beacon") });
  const mockTimelock = new MockTimelock(mockBeacon, sha256("adapters", "tlock"), new SeededRandom("adapters/tlock"));
  const mockChain = new InMemoryChain(clock);
  const beacon: Beacon = opts.slowAdapters
    ? {
        genesisTime: mockBeacon.genesisTime,
        periodMs: mockBeacon.periodMs,
        roundAt: (t) => mockBeacon.roundAt(t),
        timeOfRound: (r) => mockBeacon.timeOfRound(r),
        randomness: (r) => slow(() => mockBeacon.randomness(r)),
      }
    : mockBeacon;
  const timelock: Timelock = opts.slowAdapters
    ? { seal: (p, r) => slow(() => mockTimelock.seal(p, r)), open: (b) => slow(() => mockTimelock.open(b)) }
    : mockTimelock;
  const chain: ChainNotary = opts.slowAdapters
    ? { publish: (root) => slow(() => mockChain.publish(root)), lookup: (tx) => mockChain.lookup(tx) }
    : mockChain;
  const engine = new MukeunjiEngine({
    clock,
    beacon,
    timelock,
    notary: new TimeNotary(chain),
    rng: new SeededRandom("adapters/engine"),
    operatorSecret: sha256("adapters", "op"),
    ...(opts.membership ? { membership: opts.membership } : {}),
  });
  const memberRng = new SeededRandom("adapters/members");
  const member = () => new Member({ engine, timelock, rng: memberRng }).join();
  const advance = async (ms: number) => {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      clock.setTo(Math.min(end, clock.now() + DAY));
      await engine.tick();
    }
  };
  return { clock, engine, member, advance };
}

async function scenario(slowAdapters: boolean): Promise<ProfileView> {
  const { engine, member, advance, clock } = build({ slowAdapters });
  const s = member();
  const fs = Array.from({ length: 4 }, () => member());
  for (const f of fs) Member.befriend(s, f);
  await engine.tick();
  await advance(31 * DAY);
  const slots = fs.map((f) => f.register(s.pub));
  clock.advance(60_000);
  await engine.tick();
  for (const [i, f] of fs.entries()) await f.write(slots[i]!, endorse(`e${i}`));
  await advance(120 * DAY);
  return engine.view(s.pub);
}

describe("v2 어댑터 자리", () => {
  it("비콘·타임락·체인을 느린 비동기 구현으로 바꿔도 결과가 똑같다", async () => {
    const fast = await scenario(false);
    const slowView = await scenario(true);
    assert.equal(fast.batches.length, 1);
    assert.deepEqual(slowView, fast);
  });

  it("시각이 지났는데 라운드 값이 아직 안 들어온 비콘(네트워크 지연)에도 tick 이 멈추지 않고 다음에 처리한다", async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 1));
    const inner = new MockBeacon({ clock, seed: sha256("lag", "beacon") });
    const LAG = 2 * DAY; // 라운드 시각보다 이틀 늦게 도착
    const lagging: Beacon = {
      genesisTime: inner.genesisTime,
      periodMs: inner.periodMs,
      roundAt: (t) => inner.roundAt(t),
      timeOfRound: (r) => inner.timeOfRound(r),
      randomness: async (r) => {
        if (inner.timeOfRound(r) + LAG > clock.now()) throw new BeaconNotReadyError(r);
        return inner.randomness(r);
      },
    };
    const timelock = new MockTimelock(lagging, sha256("lag", "tlock"), new SeededRandom("lag/tlock"));
    const engine = new MukeunjiEngine({ clock, beacon: lagging, timelock, notary: new TimeNotary(new InMemoryChain(clock)), rng: new SeededRandom("lag/e") });
    const rng = new SeededRandom("lag/m");
    const s = new Member({ engine, timelock, rng }).join();
    const fs = Array.from({ length: 4 }, () => new Member({ engine, timelock, rng }).join());
    for (const f of fs) Member.befriend(s, f);
    await engine.tick();
    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        clock.advance(DAY);
        await engine.tick();
      }
    };
    await step(31);
    const slots = fs.map((f) => f.register(s.pub));
    await step(1);
    assert.equal(engine.schedule(slots[0]!), undefined, "비콘이 늦어서 아직 지연 미확정");
    await step(2);
    for (const [i, f] of fs.entries()) await f.write(slots[i]!, endorse(`e${i}`));
    await step(100);
    assert.equal(engine.view(s.pub).batches.length, 1);
  });

  it("멤버십 검증기는 교체 가능하다 (v2: Semaphore ZK 증명으로 대체할 자리)", async () => {
    const calls: string[] = [];
    const inner = new TransparentMembership();
    const spying: MembershipVerifier = {
      verify(reg, exists) {
        calls.push(reg.relationshipId);
        return inner.verify(reg, exists);
      },
    };
    const { member } = build({ slowAdapters: false, membership: spying });
    const [s, f] = [member(), member()];
    const id = Member.befriend(s, f);
    f.register(s.pub);
    assert.deepEqual(calls, [id]);

    const denyAll: MembershipVerifier = {
      verify() {
        throw new ProtocolError("not-a-party", "ZK 증명 실패");
      },
    };
    const strict = build({ slowAdapters: false, membership: denyAll });
    const [a, b] = [strict.member(), strict.member()];
    Member.befriend(a, b);
    assert.throws(() => b.register(a.pub), (e: unknown) => e instanceof ProtocolError && e.code === "not-a-party");
  });
});
