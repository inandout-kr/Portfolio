// 공격 시나리오. 각 테스트는 "공격자가 무엇을 시도하고, 무엇을 볼 수 있으며, 왜 실패하는지"를 보여준다.
// 막지 못하고 비용만 올리는 부분은 테스트 이름과 단언에 그대로 드러낸다.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BeaconNotReadyError,
  DAY,
  HOUR,
  MINUTE,
  MONTH,
  Member,
  ProtocolError,
  WEEK,
  World,
  YEAR,
  encodeContent,
  hex,
  signMessage,
  signedMessage,
  type ReviewContent,
} from "../src/index.js";
import { dump, endorse, friendsOf, neutral, revealAt, reviewAll, untilRevealed, warn } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof ProtocolError && e.code === c;

describe("공격 1 — 지연 시점 고르기 (원하는 공개 시점이 나올 때까지 다시 굴리기)", () => {
  it("등록 순간엔 지연을 정할 비콘 값이 아직 존재하지 않는다", async () => {
    const w = new World();
    const s = w.member();
    const [f] = await friendsOf(w, s, 1);
    f!.register(s.pub);
    await assert.rejects(w.beacon.randomness(w.beacon.roundAt(w.clock.now()) + 1), BeaconNotReadyError);
  });

  it("마음에 안 드는 지연이 나와도 재등록·관계 재생성·다른 라운드 봉인 모두 막힌다", async () => {
    const w = new World();
    const s = w.member();
    const [f] = await friendsOf(w, s, 1);
    const [slot] = await reviewAll(w, s, [[f!, null]]);
    const sch = w.engine.schedule(slot!)!;
    assert.throws(() => f!.register(s.pub), code("already-registered"));
    assert.throws(() => Member.befriend(f!, s), code("duplicate"));
    const chosen = await w.timelock.seal(encodeContent(endorse("x")), sch.revealRound - 100_000);
    const sig = signMessage(f!.keys, signedMessage.seal(slot!, chosen.round, chosen.ciphertext));
    assert.throws(() => w.engine.submitSealed(slot!, chosen, sig), code("wrong-round"));
  });

  it("작성자가 통제하는 건 전부 같고 비콘만 다르면 지연이 달라진다 — 지연은 비콘이 정한다", async () => {
    const delays = async (beaconSeed: string) => {
      const w = new World({ beaconSeed });
      const s = w.member();
      const fs = await friendsOf(w, s, 8);
      const t0 = w.clock.now();
      const slots = await reviewAll(w, s, fs.map((f) => [f, null] as const));
      return slots.map((sl) => revealAt(w, sl) - t0);
    };
    const a = await delays("비콘-1");
    const b = await delays("비콘-2");
    const same = a.filter((d, i) => d === b[i]).length;
    assert.equal(same, 0);
  });
});

describe("공격 2 — n-1 플러딩 (아는 평가로 묶음을 채워서 남은 하나를 특정)", () => {
  it("갓 맺은 가짜 관계로는 묶음을 못 연다 — 비판 원문은 끝까지 안 나오고 6개월 뒤 집계로만", async () => {
    const w = new World({ config: { maxNewRelationshipsPerWeek: 50 } });
    const s = w.member();
    const [h] = await friendsOf(w, s, 1);
    const [hs] = await reviewAll(w, s, [[h!, neutral("약속을 두 번 어겼다")]]);
    const sybils = await friendsOf(w, s, 10, 0);
    const ss = await reviewAll(w, s, sybils.map((x, i) => [x, endorse(`최고${i}`)] as const));
    await untilRevealed(w, [hs!, ...ss]);
    assert.equal(w.engine.view(s.pub).batches.length, 0);
    await w.advance(7 * MONTH);
    const v = w.engine.view(s.pub);
    assert.equal(v.batches.length, 0);
    assert.ok(!dump(v).includes("약속을 두 번 어겼다"));
    // 남는 누출: 집계의 중립 1건. 그래서 비판은 warn 으로 쓰는 게 안전하다 (다음 테스트).
    assert.deepEqual(v.aggregates, [{ endorse: 10, neutral: 1 }]);
  });

  it("숙성된 친구들로 채워도, 경고(warn)로 쓴 평가는 묶음에 없어서 '안 쓴 것'과 구별되지 않는다", async () => {
    const run = async (honest: ReviewContent | null) => {
      const w = new World();
      const s = w.member();
      const fs = await friendsOf(w, s, 5);
      const entries = fs.map((f, i) => [f, i === 0 ? honest : endorse(`친구${i}`)] as const);
      await untilRevealed(w, await reviewAll(w, s, entries));
      await w.advance(90 * DAY);
      return w.engine.view(s.pub);
    };
    const warned = await run(warn("돈을 안 갚았다"));
    const silent = await run(null);
    assert.equal(warned.batches.length, 1);
    assert.deepEqual(warned, silent);
  });

  it("친구 탄약은 유한하고, 친구 평가도 1주~3개월 무작위 지연을 거쳐 묶음이 열리는 시점을 못 정한다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    const t0 = w.clock.now();
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, endorse(`친구${i}`)] as const));
    for (const f of fs) assert.throws(() => f.register(s.pub), code("already-registered"));
    const times = slots.map((sl) => revealAt(w, sl));
    for (const t of times) assert.ok(t - t0 >= WEEK);
    assert.equal(new Set(times).size, times.length, "친구들 공개 시각이 제각각");
  });
});

describe("공격 3 — 점수·화면 변화로 내용 추론", () => {
  async function world(content: ReviewContent | null) {
    const w = new World();
    const s = w.member();
    const old = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, old.map((f, i) => [f, endorse(`과거${i}`)] as const)));
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, i === 0 ? content : endorse(`친구${i}`)] as const));
    return { w, s, slots };
  }

  it("내 평가가 지지든 중립이든, 묶음이 풀리기 전까지 대상 화면은 매일 똑같다", async () => {
    const A = await world(endorse("대상 평가"));
    const B = await world(neutral("대상 평가"));
    const releaseAt = Math.max(...A.slots.map((sl) => revealAt(A.w, sl)));
    let days = 0;
    while (A.w.clock.now() < releaseAt - DAY) {
      await A.w.advance(DAY);
      await B.w.advance(DAY);
      assert.deepEqual(A.w.engine.view(A.s.pub), B.w.engine.view(B.s.pub));
      days += 1;
    }
    assert.ok(days >= 7, `${days}일 동안 비교`);
    await A.w.advance(2 * DAY);
    await B.w.advance(2 * DAY);
    assert.notDeepEqual(A.w.engine.view(A.s.pub), B.w.engine.view(B.s.pub), "묶음이 풀린 뒤에야 내용이 보인다");
  });

  it("경고를 썼는지 안 썼는지는 1년이 지나도 화면에 흔적이 없다", async () => {
    const A = await world(warn("대상 평가"));
    const B = await world(null);
    for (let m = 0; m < 12; m++) {
      await A.w.advance(MONTH);
      await B.w.advance(MONTH);
      assert.deepEqual(A.w.engine.view(A.s.pub), B.w.engine.view(B.s.pub));
    }
  });
});

describe("공격 4 — 협박자가 '시킨 대로 썼는지, 몰래 고치지 않았는지' 확인하려 할 때", () => {
  async function world(edit: "real" | "cover" | "many") {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, endorse(i === 0 ? "협박받고 쓴 칭찬" : `친구${i}`)] as const));
    const [victim, slot] = [fs[0]!, slots[0]!];
    const sch = w.engine.schedule(slot)!;
    // 협박자는 피해자에게서 slotId 까지 빼앗았다고 가정한다
    const seen: unknown[] = [];
    const look = () =>
      seen.push({
        view: w.engine.view(s.pub),
        tasks: w.engine.reviewerTasks([slot]),
        schedule: w.engine.schedule(slot),
        chain: w.chain.payloads.map((p) => hex(p)),
      });
    look();
    w.clock.setTo(sch.editOpensAt + HOUR);
    await w.tick();
    look();
    if (edit === "real") seen.push(await victim.write(slot, neutral("사실은 돈을 늦게 갚았다")));
    if (edit === "cover") seen.push(await victim.coverEdit(slot));
    if (edit === "many") {
      await victim.write(slot, neutral("초안"));
      await victim.write(slot, neutral("다시"));
      seen.push(await victim.write(slot, neutral("사실은 돈을 늦게 갚았다")));
    }
    look();
    w.clock.setTo(sch.revealAt - MINUTE);
    await w.tick();
    look();
    return { seen, w, s, slots };
  }

  it("진짜 수정·위장 수정·여러 번 수정이 공개 직전까지 협박자가 볼 수 있는 모든 출력에서 똑같다", async () => {
    const real = await world("real");
    const cover = await world("cover");
    const many = await world("many");
    assert.deepEqual(real.seen, cover.seen);
    assert.deepEqual(many.seen, cover.seen);
  });

  it("공개 뒤에도 묶음엔 작성자가 없다 — 고친 내용은 섞인 n 개 중 하나일 뿐", async () => {
    const { w, s, slots } = await world("real");
    await untilRevealed(w, slots);
    const batch = w.engine.view(s.pub).batches[0]!;
    assert.equal(batch.length, 4);
    assert.ok(batch.some((i) => i.text === "사실은 돈을 늦게 갚았다"));
    for (const i of batch) assert.deepEqual(Object.keys(i).sort(), ["stance", "text"]);
  });
});

describe("공격 5 — 가짜 계정 대량 생성", () => {
  it("한 계정이 일주일에 맺을 수 있는 관계는 10개 — 공장이 아무리 커도 대상 쪽에서 막힌다", async () => {
    const w = new World();
    const t = w.member();
    for (let i = 0; i < 10; i++) Member.befriend(t, w.member());
    assert.throws(() => Member.befriend(t, w.member()), code("rate-limited"));
    await w.advance(WEEK);
    assert.ok(Member.befriend(t, w.member()));
  });

  it("10주 동안 찍어낸 가짜 100명의 지지 총합은 0 — 묶음도 한 번 못 연다", async () => {
    const w = new World();
    const honest = w.member();
    const vets = await friendsOf(w, honest, 4, 2 * YEAR);
    const hslots = await reviewAll(w, honest, vets.map((f, i) => [f, endorse(`실제${i}`)] as const));

    const target = w.member();
    let sybils = 0;
    for (let week = 0; week < 10; week++) {
      const batch = Array.from({ length: 10 }, () => w.member());
      for (const x of batch) Member.befriend(target, x);
      await reviewAll(w, target, batch.map((x) => [x, endorse("최고의 사람")] as const));
      sybils += batch.length;
      await w.advance(WEEK);
    }
    await untilRevealed(w, hslots);
    await w.advanceUntil(() => w.engine.view(target.pub).aggregates.length > 0, YEAR);
    await w.advance(31 * DAY);
    const v = w.engine.view(target.pub);
    const oneVeteran = w.engine.view(honest.pub).score / 4;
    assert.equal(sybils, 100);
    assert.equal(v.batches.length, 0);
    assert.ok(v.score < oneVeteran, `가짜 ${sybils}명 ${v.score} vs 실제 1개 ${oneVeteran}`);
    assert.equal(v.score, 0, "관계 0일에 쓴 보증은 무게가 0 (1년 재확인을 견뎌야 무거워진다)");
  });
});

describe("공격 6 — 한 명의 보복성 경고", () => {
  it("같은 사람은 경고를 반복하거나 관계를 새로 맺어 머릿수를 늘릴 수 없다", async () => {
    const w = new World();
    const s = w.member();
    const [angry] = await friendsOf(w, s, 1);
    await reviewAll(w, s, [[angry!, warn("최악")]]);
    assert.throws(() => angry!.register(s.pub), code("already-registered"));
    assert.throws(() => Member.befriend(angry!, s), code("duplicate"));
  });

  it("바람잡이 3명이 막 관계를 맺고 경고하면 공개는 되지만, 점수 타격은 1% 미만", async () => {
    const w = new World();
    const s = w.member();
    const vets = await friendsOf(w, s, 4, 2 * YEAR);
    await untilRevealed(w, await reviewAll(w, s, vets.map((f, i) => [f, endorse(`실제${i}`)] as const)));
    await w.advance(31 * DAY);
    const before = w.engine.view(s.pub).score;
    const shills = await friendsOf(w, s, 3, 0);
    await untilRevealed(w, await reviewAll(w, s, shills.map((x, i) => [x, warn(`조작된 경고${i}`)] as const)));
    await w.advance(31 * DAY);
    const v = w.engine.view(s.pub);
    assert.equal(v.warnings.length, 1);
    assert.ok(v.score <= before && v.score > before * 0.99, `${before} → ${v.score}`);
  });
});
