import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BeaconNotReadyError,
  DAY,
  DEFAULT_CONFIG,
  DRAND_QUICKNET,
  MockBeacon,
  MockTimelock,
  MONTH,
  SeededRandom,
  VirtualClock,
  YEAR,
  baseWeight,
  encodeParts,
  keyPairFromSeed,
  maturity,
  merklePath,
  merkleRoot,
  randomInt,
  sha256,
  shuffle,
  signMessage,
  standingFactor,
  verifyMerklePath,
  verifyMessage,
  firstRoundAtOrAfter,
  resolveConfig,
} from "../src/index.js";

describe("암호 유틸", () => {
  it("길이 접두 인코딩은 필드 경계가 다르면 다른 바이트가 된다", () => {
    assert.notDeepEqual(encodeParts("ab", "c"), encodeParts("a", "bc"));
    assert.notDeepEqual(sha256("ab", "c"), sha256("a", "bc"));
  });

  it("Ed25519: 시드로 결정적 키, 서명 검증, 위조 거부", () => {
    const k1 = keyPairFromSeed(Buffer.alloc(32, 1));
    const k2 = keyPairFromSeed(Buffer.alloc(32, 1));
    const other = keyPairFromSeed(Buffer.alloc(32, 2));
    assert.equal(k1.publicKey, k2.publicKey);
    assert.match(k1.publicKey, /^[0-9a-f]{64}$/);
    const msg = Buffer.from("묵은지");
    const sig = signMessage(k1, msg);
    assert.ok(verifyMessage(k1.publicKey, msg, sig));
    assert.ok(!verifyMessage(other.publicKey, msg, sig));
    assert.ok(!verifyMessage(k1.publicKey, Buffer.from("묵은지!"), sig));
    assert.ok(!verifyMessage(k1.publicKey, msg, "zz"));
  });

  it("시드 난수: 재현 가능, randomInt 범위, shuffle 은 순열", () => {
    const a = new SeededRandom("s");
    const b = new SeededRandom("s");
    assert.deepEqual(a.bytes(40), b.bytes(40));
    const r = new SeededRandom("r");
    for (let i = 0; i < 500; i++) {
      const x = randomInt(r, 7);
      assert.ok(x >= 0 && x < 7);
    }
    const items = [1, 2, 3, 4, 5, 6];
    const s = shuffle(items, r);
    assert.deepEqual([...s].sort(), items);
    assert.deepEqual(items, [1, 2, 3, 4, 5, 6]);
  });
});

describe("머클 트리", () => {
  it("1~9 개 잎 모든 위치의 경로가 검증되고, 다른 잎·루트는 거부된다", () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = Array.from({ length: n }, (_, i) => sha256("leaf", i));
      const root = merkleRoot(leaves).toString("hex");
      for (let i = 0; i < n; i++) {
        const path = merklePath(leaves, i);
        assert.ok(verifyMerklePath(leaves[i]!, path, root), `n=${n} i=${i}`);
        assert.ok(!verifyMerklePath(sha256("forged"), path, root));
      }
    }
  });
});

describe("비콘 (drand 모델)", () => {
  it("quicknet 상수: 3초 주기, 라운드↔시각 왕복", () => {
    const clock = new VirtualClock(Date.UTC(2026, 9, 24));
    const b = new MockBeacon({ clock, seed: Buffer.from("x") });
    assert.equal(b.periodMs, DRAND_QUICKNET.periodMs);
    assert.equal(b.roundAt(DRAND_QUICKNET.genesisTime), 1);
    const r = b.roundAt(clock.now());
    assert.ok(b.timeOfRound(r) <= clock.now() && clock.now() < b.timeOfRound(r + 1));
    const t = clock.now() + 1;
    assert.ok(b.timeOfRound(firstRoundAtOrAfter(b, t)) >= t);
  });

  it("미래 라운드 값은 존재하지 않는다 → 시각이 와야 공개", async () => {
    const clock = new VirtualClock(Date.UTC(2026, 9, 24));
    const b = new MockBeacon({ clock, seed: Buffer.from("x") });
    const next = b.roundAt(clock.now()) + 1;
    await assert.rejects(b.randomness(next), BeaconNotReadyError);
    clock.advance(3_000);
    const v1 = await b.randomness(next);
    const v2 = await b.randomness(next);
    assert.deepEqual(v1, v2);
  });
});

describe("타임락 봉인", () => {
  it("라운드 전엔 아무도 못 열고, 라운드가 오면 열린다. 같은 내용도 매번 다른 암호문", async () => {
    const clock = new VirtualClock(Date.UTC(2026, 9, 24));
    const beacon = new MockBeacon({ clock, seed: Buffer.from("x") });
    const tl = new MockTimelock(beacon, Buffer.from("master"), new SeededRandom("t"));
    const round = beacon.roundAt(clock.now() + DAY);
    const box1 = await tl.seal(Buffer.from("비밀"), round);
    const box2 = await tl.seal(Buffer.from("비밀"), round);
    assert.notDeepEqual(box1.ciphertext, box2.ciphertext);
    assert.equal(box1.round, round);
    await assert.rejects(tl.open(box1), BeaconNotReadyError);
    clock.advance(DAY);
    assert.equal((await tl.open(box1)).toString(), "비밀");
  });
});

describe("가중치 곡선 (규칙 9 재료)", () => {
  const full = DEFAULT_CONFIG.maturityFullAge;

  it("숙성도는 제곱 곡선: 초반엔 거의 0, 2년에 만점", () => {
    assert.equal(maturity(0, full), 0);
    assert.ok(maturity(MONTH, full) < 0.002);
    assert.ok(Math.abs(maturity(YEAR, full) - 0.25) < 1e-9);
    assert.equal(maturity(2 * YEAR, full), 1);
    assert.equal(maturity(5 * YEAR, full), 1);
  });

  it("standing 은 0.2~1 사이에서 받은 신뢰가 클수록 커진다", () => {
    assert.equal(standingFactor(0), 0.2);
    assert.ok(standingFactor(1) > standingFactor(0.1));
    assert.ok(standingFactor(100) <= 1);
  });

  it("계정 숙성도와 관계 나이 둘 다 있어야 무겁다 — 하나만 오래돼선 0에 가깝다", () => {
    const full = baseWeight(2 * YEAR, 2 * YEAR, 0, DEFAULT_CONFIG);
    assert.equal(full, 1);
    assert.ok(baseWeight(2 * YEAR, DAY, 0, DEFAULT_CONFIG) < 0.001 * full, "오래된 계정이 갓 맺은 관계로 보증");
    assert.ok(baseWeight(DAY, 2 * YEAR, 0, DEFAULT_CONFIG) < 0.001 * full, "갓 만든 계정");
  });

  it("잘못된 설정은 거부한다", () => {
    assert.throws(() => resolveConfig({ batchSize: 1 }), RangeError);
    assert.throws(() => resolveConfig({ minDelay: DAY }), RangeError, "수정 창보다 짧은 지연");
    assert.throws(() => resolveConfig({ reaffirmBonus: [1, 2] }), RangeError);
    assert.equal(resolveConfig().batchSize, 4);
  });

  it("재확인 단계마다 배수가 커진다", () => {
    const w = (lvl: number) => baseWeight(2 * YEAR, 2 * YEAR, lvl, DEFAULT_CONFIG);
    assert.ok(w(0) < w(1) && w(1) < w(2));
    assert.throws(() => w(3), RangeError);
  });
});
