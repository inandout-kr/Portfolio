// 확정 규칙 1~12 를 하나씩 증명한다.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BeaconNotReadyError,
  DAY,
  MINUTE,
  MONTH,
  Member,
  PatinaEngine,
  ProtocolError,
  World,
  YEAR,
  fromHex,
  hex,
  orderPair,
  relationshipCommitment,
  renderCurve,
  signMessage,
  signedMessage,
  verifyInclusion,
  type Handshake,
  type ProfileView,
} from "../src/index.js";
import { dump, endorse, friendsOf, neutral, revealAt, reviewAll, untilRevealed, warn } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof ProtocolError && e.code === c;

describe("규칙 1 — 관계: 상호 서명, 해시+공증 시각만 저장, 나이 위조 불가", () => {
  function handshake(x: Member, y: Member, forgeB?: Member): Handshake {
    const [a, b] = orderPair(x.pub, y.pub);
    const opening = { a, b, nonce: hex(Buffer.alloc(32, 7)) };
    const id = relationshipCommitment(opening);
    const sig = (m: Member) => signMessage(m.keys, signedMessage.handshake(id));
    const [ma, mb] = a === x.pub ? [x, y] : [y, x];
    return { opening, sigA: sig(ma), sigB: sig(forgeB ?? mb) };
  }

  it("한쪽 서명만으로는 관계가 생기지 않는다", () => {
    const w = new World();
    const [x, y, z] = [w.member(), w.member(), w.member()];
    assert.throws(() => w.engine.createRelationship(handshake(x, y, z)), code("bad-signature"));
    assert.throws(() => w.engine.createRelationship({ ...handshake(x, y), sigB: "" }), code("bad-signature"));
    assert.ok(w.engine.createRelationship(handshake(x, y)));
  });

  it("자기 자신·미가입 계정·같은 쌍의 두 번째 관계는 거부", () => {
    const w = new World();
    const [x, y] = [w.member(), w.member()];
    const ghost = new Member({ engine: w.engine, timelock: w.timelock });
    assert.throws(() => Member.befriend(x, x), code("self-relationship"));
    assert.throws(() => Member.befriend(x, ghost), code("unknown-account"));
    Member.befriend(x, y);
    assert.throws(() => Member.befriend(y, x), code("duplicate"));
  });

  it("엔진에 남는 건 해시와 공증 시각뿐 — 두 사람의 공개키는 기록에 없다", async () => {
    const w = new World();
    const [x, y] = [w.member(), w.member()];
    const id = Member.befriend(x, y);
    assert.deepEqual(w.engine.relationshipRecord(id), { id, anchoredAt: null });
    await w.tick();
    const rec = w.engine.relationshipRecord(id)!;
    assert.deepEqual(Object.keys(rec).sort(), ["anchoredAt", "id"]);
    assert.equal(rec.anchoredAt, w.clock.now());
    assert.ok(!dump(rec).includes(x.pub) && !dump(rec).includes(y.pub));
  });

  it("관계 나이는 체인 시각으로만 증명되고, 날짜를 바꿔 끼우면 검증이 깨진다", async () => {
    const w = new World();
    const [x, y, z] = [w.member(), w.member(), w.member()];
    const id = Member.befriend(x, y);
    // 시각을 주장하는 필드를 끼워 넣어도 엔진은 쓰지 않는다
    const claimed = w.engine.createRelationship({ ...handshake(x, z), createdAt: 0 } as Handshake);
    w.clock.advance(DAY);
    await w.tick();
    assert.equal(w.engine.relationshipRecord(claimed)!.anchoredAt, w.clock.now());

    const proof = w.notary.proof(fromHex(id))!;
    assert.ok(verifyInclusion(proof, w.chain));
    assert.ok(!verifyInclusion({ ...proof, anchoredAt: proof.anchoredAt - YEAR }, w.chain), "백데이팅");
    assert.ok(!verifyInclusion({ ...proof, leaf: hex(Buffer.alloc(32)) }, w.chain), "다른 잎");
  });
});

describe("규칙 2 — 평가 등록: 관계당 1회·취소 불가, 지연은 등록 이후 비콘으로, 내용은 타임락", () => {
  it("같은 관계로 두 번 등록할 수 없다. 반대 방향 평가는 별개 자리", async () => {
    const w = new World();
    const s = w.member();
    const [f] = await friendsOf(w, s, 1);
    f!.register(s.pub);
    assert.throws(() => f!.register(s.pub), code("already-registered"));
    assert.ok(s.register(f!.pub));
  });

  it("등록 직후엔 지연이 없고, 그다음 비콘 라운드가 공개돼야 정해진다", async () => {
    const w = new World();
    const s = w.member();
    const [f] = await friendsOf(w, s, 1);
    const slot = f!.register(s.pub);
    assert.equal(w.engine.schedule(slot), undefined);
    await assert.rejects(f!.write(slot, endorse("x")));
    await assert.rejects(w.beacon.randomness(w.beacon.roundAt(w.clock.now()) + 1), BeaconNotReadyError);
    await w.tick();
    assert.equal(w.engine.schedule(slot), undefined, "같은 시각엔 아직");
    w.clock.advance(MINUTE);
    await w.tick();
    assert.ok(w.engine.schedule(slot));
  });

  it("공개 지연은 1주~3개월에 고르게 퍼진다", async () => {
    const w = new World({ config: { maxNewRelationshipsPerWeek: 100 } });
    const s = w.member();
    const fs = await friendsOf(w, s, 60, 0);
    const t0 = w.clock.now();
    const slots = await reviewAll(w, s, fs.map((f) => [f, null] as const));
    const days = slots.map((sl) => (revealAt(w, sl) - t0) / DAY);
    for (const d of days) assert.ok(d >= 7 && d <= 90 + 1 / 24, `지연 ${d}일`);
    const mean = days.reduce((a, b) => a + b, 0) / days.length;
    assert.ok(mean > 40 && mean < 57, `평균 ${mean}일`);
    assert.ok(Math.min(...days) < 20 && Math.max(...days) > 75);
  });

  it("봉인은 공개 라운드 전엔 못 열고, 정해진 라운드·작성자 서명이 아니면 제출 거부", async () => {
    const w = new World();
    const s = w.member();
    const [f] = await friendsOf(w, s, 1);
    const [slot] = await reviewAll(w, s, [[f!, endorse("좋은 사람")]]);
    const sch = w.engine.schedule(slot!)!;
    const box = await w.timelock.seal(Buffer.from("x"), sch.revealRound);
    await assert.rejects(w.timelock.open(box), BeaconNotReadyError);
    const early = await w.timelock.seal(Buffer.from("x"), sch.revealRound - 1000);
    const sealSig = (m: Member, b: typeof box) => signMessage(m.keys, signedMessage.seal(slot!, b.round, b.ciphertext));
    assert.throws(() => w.engine.submitSealed(slot!, early, sealSig(f!, early)), code("wrong-round"));
    assert.throws(() => w.engine.submitSealed(slot!, box, sealSig(s, box)), code("bad-signature"));
  });

  it("서명은 맞는데 내용이 깨진 봉인은 공개 때 '안 쓴 것'이 된다 (엔진은 멈추지 않는다)", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 6);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, i < 2 ? null : endorse(`e${i}`)] as const));
    const submit = (i: number, ciphertext: Buffer) => {
      const box = { round: w.engine.schedule(slots[i]!)!.revealRound, ciphertext };
      w.engine.submitSealed(slots[i]!, box, signMessage(fs[i]!.keys, signedMessage.seal(slots[i]!, box.round, box.ciphertext)));
    };
    submit(0, Buffer.from("not-a-ciphertext")); // 복호화 자체가 실패
    submit(1, (await w.timelock.seal(Buffer.from("{not json"), w.engine.schedule(slots[1]!)!.revealRound)).ciphertext); // 형식 불량
    await untilRevealed(w, slots);
    const v = w.engine.view(s.pub);
    assert.equal(v.batches.length, 1);
    assert.deepEqual(v.batches[0]!.map((i) => i.text).sort(), ["e2", "e3", "e4", "e5"]);
  });

  it("등록만 하고 안 쓴 자리는 소모되고, 공개 때 조용히 사라진다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, i === 0 ? null : endorse(`e${i}`)] as const));
    await untilRevealed(w, slots);
    assert.throws(() => fs[0]!.register(s.pub), code("already-registered"));
    assert.equal(w.engine.view(s.pub).batches.length, 0, "숙성 평가 3개뿐이라 묶음 안 열림");
  });
});

describe("규칙 3 — 수정 창: 공개 전 48시간, 횟수 무제한, 마지막 것만, 영수증 없음", () => {
  it("창 전엔 거부, 창 안에선 여러 번, 공개되는 건 마지막 것, 공개 뒤엔 거부", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, endorse(`초안${i}`)] as const));
    const [me, slot] = [fs[0]!, slots[0]!];
    const sch = w.engine.schedule(slot)!;
    await assert.rejects(me.write(slot, endorse("너무 이른 수정")), code("edit-window-closed"));
    assert.deepEqual(me.tasks(), []);

    w.clock.setTo(sch.editOpensAt);
    await w.tick();
    assert.deepEqual(
      me.tasks().map((t) => t.kind),
      ["edit"],
    );
    const acks = [
      await me.write(slot, neutral("두 번째 생각")),
      await me.coverEdit(slot),
      await me.write(slot, neutral("최종: 약속은 지켰지만 연락이 늦었다")),
    ];
    for (const a of acks) assert.deepEqual(a, { ok: true });

    await untilRevealed(w, slots);
    await assert.rejects(me.write(slot, endorse("공개 후")), code("revealed"));
    const texts = w.engine.view(s.pub).batches.flat().map((i) => i.text);
    assert.ok(texts.includes("최종: 약속은 지켰지만 연락이 늦었다"));
    assert.ok(!texts.includes("초안0") && !texts.includes("두 번째 생각"));
  });
});

describe("규칙 4 — 열람: 숙성 평가 n 개가 모여야 섞인 묶음으로, 날짜·순서·대기 개수 없음", () => {
  it("n-1 개까지는 아무것도 안 보이고 n 번째가 풀리는 순간 묶음 공개", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, endorse(`평가${i}`)] as const));
    const times = slots.map((sl) => revealAt(w, sl)).sort((a, b) => a - b);
    w.clock.setTo(times[3]! - 1);
    await w.tick();
    assert.equal(w.engine.view(s.pub).batches.length, 0);
    w.clock.setTo(times[3]!);
    await w.tick();
    const v = w.engine.view(s.pub);
    assert.equal(v.batches.length, 1);
    assert.deepEqual(v.batches[0]!.map((i) => i.text).sort(), ["평가0", "평가1", "평가2", "평가3"]);
  });

  it("화면엔 대기 개수·도착 필드가 없고, 묶음 항목엔 stance·text 만 있다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, fs.map((f, i) => [f, endorse(`평가${i}`)] as const)));
    const v = w.engine.view(s.pub);
    assert.deepEqual(Object.keys(v).sort(), ["aggregates", "batches", "curve", "score", "subject", "warnings"]);
    for (const item of v.batches.flat()) assert.deepEqual(Object.keys(item).sort(), ["stance", "text"]);
  });

  it("묶음 안 순서는 해제 순서와 무관하게 섞인다", async () => {
    const w = new World();
    const groups: { s: Member; fs: Member[] }[] = [];
    for (let g = 0; g < 6; g++) {
      const s = w.member();
      const fs = Array.from({ length: 4 }, () => w.member());
      for (const f of fs) Member.befriend(s, f);
      groups.push({ s, fs });
    }
    await w.tick();
    await w.advance(31 * DAY);
    const all: string[] = [];
    const orders: string[][] = [];
    for (const [g, { s, fs }] of groups.entries()) {
      const slots = await reviewAll(w, s, fs.map((f, i) => [f, endorse(`g${g}-${i}`)] as const));
      all.push(...slots);
      orders.push(
        slots
          .map((sl, i) => ({ t: revealAt(w, sl), text: `g${g}-${i}` }))
          .sort((a, b) => a.t - b.t)
          .map((x) => x.text),
      );
    }
    // 각 평가를 자기 공개 시각에 하나씩 풀어서, 셔플이 없으면 묶음 순서 = 해제 순서가 되게 한다
    for (const t of all.map((sl) => revealAt(w, sl)).sort((a, b) => a - b)) {
      w.clock.setTo(t);
      await w.tick();
    }
    const sameAsRevealOrder = groups.filter(
      ({ s }, g) => dump(w.engine.view(s.pub).batches[0]!.map((i) => i.text)) === dump(orders[g]),
    ).length;
    assert.ok(sameAsRevealOrder < groups.length);
  });
});

describe("규칙 5 — 파생 지표도 묶음 단위로만: 받는 사람이 못 보는 건 아무도 못 본다", () => {
  it("개별 평가가 풀려도 화면은 다시 계산조차 되지 않고, 묶음이 풀릴 때만 바뀐다", async () => {
    const w = new World();
    const s = w.member();
    // 이미 공개된 묶음 하나: 점수가 시간에 따라 변하는 상태에서 시작
    const old = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, old.map((f, i) => [f, endorse(`과거${i}`)] as const)));
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, endorse(`새${i}`)] as const));
    const times = slots.map((sl) => revealAt(w, sl)).sort((a, b) => a - b);
    for (const t of times.slice(0, 3)) {
      w.clock.setTo(t - 1);
      await w.tick();
      const before = w.engine.view(s.pub);
      w.clock.setTo(t);
      await w.tick();
      assert.equal(w.engine.view(s.pub), before, "같은 스냅숏 객체 그대로");
    }
    const before = w.engine.view(s.pub);
    w.clock.setTo(times[3]!);
    await w.tick();
    const after = w.engine.view(s.pub);
    assert.equal(after.batches.length, before.batches.length + 1);
  });

  it("시간이 흘러 오르는 점수도 고정 달력 주기(30일)에만 갱신된다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, fs.map((f, i) => [f, endorse(`e${i}`)] as const)));
    let prev = w.engine.view(s.pub);
    let changes = 0;
    for (let d = 0; d < 120; d++) {
      const epochBefore = Math.floor(w.clock.now() / w.engine.config.profileRefreshPeriod);
      await w.advance(DAY);
      const v = w.engine.view(s.pub);
      if (v !== prev) {
        changes += 1;
        assert.notEqual(Math.floor(w.clock.now() / w.engine.config.profileRefreshPeriod), epochBefore);
      }
      prev = v;
    }
    assert.ok(changes >= 3 && changes <= 5, `갱신 ${changes}회`);
  });
});

describe("규칙 6 — n 은 숙성된 관계에서 온 봉인 풀린 평가만 센다", () => {
  it("새 관계 평가는 아무리 쌓여도 묶음을 못 열고, 숙성 평가가 차면 함께 풀린다", async () => {
    const w = new World({ config: { aggregateAfter: 2 * YEAR } });
    const s = w.member();
    const fresh = await friendsOf(w, s, 4, 0);
    const fslots = await reviewAll(w, s, fresh.map((f, i) => [f, endorse(`새관계${i}`)] as const));
    await untilRevealed(w, fslots);
    assert.equal(w.engine.view(s.pub).batches.length, 0);

    const mature = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, mature.map((f, i) => [f, endorse(`묵은관계${i}`)] as const)));
    const v = w.engine.view(s.pub);
    assert.equal(v.batches.length, 1);
    assert.equal(v.batches[0]!.length, 8, "새 관계 평가는 묶음에 함께 실려 나간다");
  });

  it("숙성은 등록 시점 기준 — 29일 된 관계는 공개 때 30일이 넘어도 안 센다", async () => {
    const w = new World({ config: { aggregateAfter: 2 * YEAR } });
    const s = w.member();
    const fs = await friendsOf(w, s, 4, 29 * DAY);
    await untilRevealed(w, await reviewAll(w, s, fs.map((f, i) => [f, endorse(`e${i}`)] as const)));
    await w.advance(30 * DAY);
    assert.equal(w.engine.view(s.pub).batches.length, 0);
  });
});

describe("규칙 7·8 — 1년·3년 재확인과 신뢰 리텐션 커브", () => {
  async function world(keep1y: readonly boolean[], keep3y: readonly boolean[]) {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, endorse(`지지${i}`)] as const));
    await untilRevealed(w, slots);
    const reaffirmedAt: number[] = [];
    const respond = () => {
      for (const [i, f] of fs.entries()) {
        for (const t of f.tasks()) {
          if (t.kind !== "reaffirm") continue;
          if (t.checkpoint === 0 ? keep1y[i] : keep3y[i]) {
            f.reaffirm(t.slotId, t.checkpoint);
            reaffirmedAt.push(w.clock.now());
          }
        }
      }
    };
    return { w, s, fs, slots, respond, reaffirmedAt };
  }
  const kt = (v: ProfileView, i: number) => [v.curve[i]!.kept, v.curve[i]!.total];

  it("재확인한 지지만 살아남고, 커브는 3개월·1년·3년 비율과 표본 수를 보여준다", async () => {
    const { w, s, respond } = await world([true, true, false, false], [true, false, false, false]);
    let v = w.engine.view(s.pub);
    assert.deepEqual(
      v.curve.map((p) => p.label),
      ["3개월", "1년", "3년"],
    );
    assert.deepEqual(kt(v, 0), [4, 4]);
    assert.equal(v.curve[1]!.rate, null);

    await w.advance(YEAR + 45 * DAY, DAY, respond);
    v = w.engine.view(s.pub);
    assert.deepEqual(kt(v, 1), [2, 4]);

    await w.advance(2 * YEAR, DAY, respond);
    v = w.engine.view(s.pub);
    assert.deepEqual(kt(v, 2), [1, 4]);
    const text = renderCurve(v, "테스트");
    assert.match(text, /1년.*50%.*\(n=4\)/);
    assert.match(text, /3년.*25%.*\(n=4\)/);
    assert.ok(!("stars" in v) && !("rating" in v), "별점 필드 없음");
  });

  it("재확인 결과도 n 개가 차야 한꺼번에 반영된다 (한 명의 응답은 안 보인다)", async () => {
    const { w, s, respond, reaffirmedAt } = await world([true, true, false, false], [false, false, false, false]);
    const totals = new Set<number>();
    await w.advance(YEAR + 45 * DAY, DAY, () => {
      respond();
      totals.add(w.engine.view(s.pub).curve[1]!.total);
    });
    assert.ok(reaffirmedAt.length === 2);
    assert.deepEqual([...totals].sort(), [0, 4]);
  });

  it("아무도 재확인 안 하면 지지는 조용히 소멸해 점수가 0, 전원 재확인이 일부보다 무겁다", async () => {
    const none = await world([false, false, false, false], []);
    const half = await world([true, true, false, false], []);
    const all = await world([true, true, true, true], []);
    for (const x of [none, half, all]) await x.w.advance(YEAR + 75 * DAY, DAY, x.respond);
    const score = (x: typeof none) => x.w.engine.view(x.s.pub).score;
    assert.equal(score(none), 0);
    assert.ok(score(all) > score(half) && score(half) > 0);
  });

  it("열린 요청이 없거나 작성자 서명이 아니면 재확인 거부", async () => {
    const { w, s, fs, slots } = await world([], []);
    assert.throws(() => fs[0]!.reaffirm(slots[0]!, 0), code("no-prompt"));
    // 요청은 각자의 공개 시각 + 1년에 열린다 (평가마다 공개 시각이 달라서 시간을 고정하면 이미 기한이 지났을 수 있다)
    await w.advanceUntil(() => fs[0]!.tasks().some((t) => t.kind === "reaffirm"), YEAR + 100 * DAY);
    const task = fs[0]!.tasks().find((t) => t.kind === "reaffirm");
    assert.ok(task);
    assert.throws(
      () => w.engine.reaffirm(task.slotId, 0, signMessage(s.keys, signedMessage.reaffirm(task.slotId, 0))),
      code("bad-signature"),
    );
  });
});

describe("규칙 9 — 가중치: 보증인 숙성도 × 관계 나이 × 재확인 보너스", () => {
  it("2년 묵은 보증 4개 vs 갓 시작한 보증 4개 — 신규 쪽은 1% 미만", async () => {
    const w = new World();
    const vet = w.member();
    const vf = await friendsOf(w, vet, 4, 2 * YEAR);
    const vs = await reviewAll(w, vet, vf.map((f, i) => [f, endorse(`v${i}`)] as const));
    const rookie = w.member();
    const rf = await friendsOf(w, rookie, 4);
    const rs = await reviewAll(w, rookie, rf.map((f, i) => [f, endorse(`r${i}`)] as const));
    await untilRevealed(w, [...vs, ...rs]);
    await w.advance(31 * DAY);
    const a = w.engine.view(vet.pub).score;
    const b = w.engine.view(rookie.pub).score;
    assert.ok(a > 0.5, `베테랑 ${a}`);
    assert.ok(b < a * 0.01, `신규 ${b} vs ${a}`);
  });
});

describe("규칙 9 — (계속) 같은 보증도 1년 재확인을 견디면 훨씬 무거워진다", () => {
  it("관계 나이는 보증한 순간 기준이라, 재확인 전후 점수가 100배 넘게 차이 난다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, fs.map((f, i) => [f, endorse(`e${i}`)] as const)));
    const respond = () => {
      for (const f of fs) for (const t of f.tasks()) if (t.kind === "reaffirm") f.reaffirm(t.slotId, t.checkpoint);
    };
    await w.advance(YEAR - 120 * DAY, DAY, respond);
    const before = w.engine.view(s.pub).score;
    await w.advance(200 * DAY, DAY, respond);
    const after = w.engine.view(s.pub);
    assert.deepEqual([after.curve[1]!.kept, after.curve[1]!.total], [4, 4]);
    assert.ok(before > 0 && after.score > 100 * before, `${before} → ${after.score}`);
  });
});

describe("규칙 9 — (계속) 재확인 보너스", () => {
  it("보너스 설정만 다른 두 세계: 1년 재확인 뒤 점수 비는 정확히 2배, 3년 뒤엔 3배", async () => {
    const run = async (reaffirmBonus: readonly number[]) => {
      const w = new World({ config: { reaffirmBonus } });
      const s = w.member();
      const fs = await friendsOf(w, s, 4);
      await untilRevealed(w, await reviewAll(w, s, fs.map((f, i) => [f, endorse(`e${i}`)] as const)));
      const respond = () => {
        for (const f of fs) for (const t of f.tasks()) if (t.kind === "reaffirm") f.reaffirm(t.slotId, t.checkpoint);
      };
      const scores: number[] = [];
      await w.advance(YEAR + 75 * DAY, DAY, respond);
      scores.push(w.engine.view(s.pub).score);
      await w.advance(2 * YEAR, DAY, respond);
      scores.push(w.engine.view(s.pub).score);
      return scores;
    };
    const flat = await run([1, 1, 1]);
    const bonus = await run([1, 2, 3]);
    assert.ok(Math.abs(bonus[0]! / flat[0]! - 2) < 1e-9, `1년: ${bonus[0]} / ${flat[0]}`);
    assert.ok(Math.abs(bonus[1]! / flat[1]! - 3) < 1e-9, `3년: ${bonus[1]} / ${flat[1]}`);
  });
});

describe("규칙 10 — 경고: 한 명은 묻히고, 서로 다른 관계 k 명이 모이면 공개", () => {
  async function scenario(warners: number) {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 7);
    const entries = fs.map((f, i) => [f, i < 4 ? endorse(`지지${i}`) : i - 4 < warners ? warn(`경고${i - 4}`) : null] as const);
    await untilRevealed(w, await reviewAll(w, s, entries));
    await w.advance(60 * DAY);
    return w.engine.view(s.pub);
  }

  it("경고 1·2건은 '안 쓴 것'과 화면이 똑같고, 3건째에 묶음째 공개된다", async () => {
    const [none, one, two, three] = [await scenario(0), await scenario(1), await scenario(2), await scenario(3)];
    assert.deepEqual(one, none);
    assert.deepEqual(two, none);
    assert.equal(three.warnings.length, 1);
    assert.deepEqual([...three.warnings[0]!].sort(), ["경고0", "경고1", "경고2"]);
    assert.ok(three.score < none.score, "공개된 경고는 점수를 깎는다");
    assert.ok(!dump(three.batches).includes("경고"), "경고는 묶음에 섞이지 않는다");
  });

  it("경고는 n 에도 안 센다 — 지지 3 + 경고 1 이면 묶음이 안 열리고, 집계에도 안 잡힌다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    const slots = await reviewAll(w, s, fs.map((f, i) => [f, i < 3 ? endorse(`e${i}`) : warn("w")] as const));
    await untilRevealed(w, slots);
    assert.equal(w.engine.view(s.pub).batches.length, 0);
    await w.advance(7 * MONTH);
    assert.deepEqual(w.engine.view(s.pub).aggregates, [{ endorse: 3, neutral: 0 }]);
  });
});

describe("규칙 11 — 6개월 넘게 묶음이 안 차면 원문 대신 집계만", () => {
  it("6개월 전엔 아무것도, 넘으면 집계만 — 원문은 화면 어디에도 없다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 3);
    const slots = await reviewAll(w, s, [
      [fs[0]!, endorse("원문A")],
      [fs[1]!, endorse("원문B")],
      [fs[2]!, neutral("원문C")],
    ]);
    await untilRevealed(w, slots);
    const first = Math.min(...slots.map((sl) => revealAt(w, sl)));
    w.clock.setTo(first + 6 * MONTH - DAY);
    await w.tick();
    assert.deepEqual(w.engine.view(s.pub).aggregates, []);
    w.clock.setTo(first + 6 * MONTH + DAY);
    await w.tick();
    const v = w.engine.view(s.pub);
    assert.deepEqual(v.aggregates, [{ endorse: 2, neutral: 1 }]);
    assert.ok(!dump(v).includes("원문"));
    assert.deepEqual([v.curve[0]!.kept, v.curve[0]!.total], [2, 3]);
  });
});

describe("규칙 12 — 토큰 없음·양도 불가, 체인은 머클루트 공증만", () => {
  it("체인에 올라간 건 전부 32바이트 루트 — 공개키·관계 id·내용은 그대로 안 올라간다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, fs.map((f, i) => [f, endorse(`비밀내용${i}`)] as const)));
    const secrets = [s.pub, ...fs.map((f) => f.pub), ...fs.map((f) => f.relationships.get(s.pub)!.id)];
    assert.ok(w.chain.payloads.length > 0);
    for (const p of w.chain.payloads) {
      assert.equal(p.length, 32);
      assert.ok(!secrets.includes(p.toString("hex")));
      assert.ok(!p.toString("utf8").includes("비밀"));
    }
    await assert.rejects(w.chain.publish(Buffer.alloc(33)), RangeError);
  });

  it("엔진·클라이언트 어디에도 이전·발행·잔고 같은 자산 연산이 없다", () => {
    const names = [...Object.getOwnPropertyNames(PatinaEngine.prototype), ...Object.getOwnPropertyNames(Member.prototype)];
    assert.ok(names.includes("view"));
    for (const n of names) assert.doesNotMatch(n, /transfer|mint|burn|token|balance|sell|buy|trade|withdraw/i);
  });

  it("평판은 공개키에 묶여 있다 — 다른 키로는 그 평판을 보여줄 방법이 없다", async () => {
    const w = new World();
    const s = w.member();
    const fs = await friendsOf(w, s, 4);
    await untilRevealed(w, await reviewAll(w, s, fs.map((f, i) => [f, endorse(`e${i}`)] as const)));
    const buyer = w.member();
    assert.equal(w.engine.view(s.pub).batches.length, 1);
    assert.equal(w.engine.view(buyer.pub).batches.length, 0);
    assert.equal(w.engine.view(buyer.pub).score, 0);
  });
});
