// 앱 흐름: 휴대폰 로직(PatinaClient) ↔ 운영자 서비스(AppService), 브라우저 데모 전송(localApi)과 HTTP 둘 다.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { ApiError, codeFromScan, formatCode, httpApi, localApi, type PatinaApi } from "../app/api.js";
import { PatinaClient, memoryStore } from "../app/client/patina-client.js";
import { createPatinaServer } from "../app/server.js";
import { AppService } from "../app/service.js";
import { DAY, MINUTE, YEAR } from "../src/time.js";
import type { PatinaConfig } from "../src/config.js";

function setup(config?: Partial<PatinaConfig>) {
  const service = new AppService({ demo: true, seed: "app-test", ...(config ? { config } : {}) });
  const api = localApi(service);
  const client = () => PatinaClient.open(api, memoryStore());
  return { service, api, client };
}

const rejectsWith = (code: string) => (e: unknown) => e instanceof ApiError && e.code === code;

/** A 가 코드를 보여주고 B 가 입력하고, 확인 숫자를 맞춘 뒤 A 가 승인한다. */
async function connect(api: PatinaApi, a: PatinaClient, b: PatinaClient) {
  const invite = await a.createInvite();
  const joined = await b.acceptInvite(invite.code);
  const seen = await api.getInvite(invite.code);
  assert.equal(seen.status, "accepted");
  assert.equal(a.digitsFor(seen), joined.digits, "두 화면의 확인 숫자가 같아야 한다");
  const done = await a.confirmInvite(seen);
  assert.equal(done.status, "done");
  await b.remember(await api.getInvite(invite.code));
  return done.relationshipId!;
}

describe("앱 — 연결 (초대코드 + 확인 숫자)", () => {
  it("코드를 주고받고 확인 숫자를 맞추면 양쪽 기기에 같은 관계가 생긴다", async () => {
    const { api, client, service } = setup();
    const [a, b] = [await client(), await client()];
    const id = await connect(api, a, b);
    assert.deepEqual(
      a.contacts().map((c) => [c.id, c.other]),
      [[id, b.pub]],
    );
    assert.deepEqual(
      b.contacts().map((c) => [c.id, c.other]),
      [[id, a.pub]],
    );
    assert.ok(service.engine.relationshipRecord(id));
  });

  it("코드는 6자, 하이픈·소문자·링크 어느 형태로 넣어도 된다", async () => {
    const { client } = setup();
    const a = await client();
    const inv = await a.createInvite();
    assert.match(inv.code, /^[2-9A-HJKMNP-Z]{6}$/);
    assert.equal(codeFromScan(`https://x.example/?join=${formatCode(inv.code).toLowerCase()}`), inv.code);
    const b = await client();
    const { view } = await b.acceptInvite(formatCode(inv.code).toLowerCase());
    assert.equal(view.status, "accepted");
  });

  it("내 코드 입력·남의 서명·만료·없는 코드·승인 전 확정·같은 사람 두 번 연결은 거부된다", async () => {
    const { api, client, service } = setup();
    const [a, b] = [await client(), await client()];
    const inv = await a.createInvite();
    await assert.rejects(a.acceptInvite(inv.code), /내 코드/);
    await assert.rejects(api.acceptInvite(inv.code, { pub: b.pub, signature: "00".repeat(64) }), rejectsWith("bad-signature"));
    await assert.rejects(api.confirmInvite(inv.code, { signature: "00".repeat(64) }), rejectsWith("invite-not-accepted"));
    await assert.rejects(api.getInvite("ZZZZZZ"), rejectsWith("unknown-invite"));
    await service.demoAdvance(11 * MINUTE);
    assert.equal((await api.getInvite(inv.code)).status, "expired");
    await assert.rejects(b.acceptInvite(inv.code), rejectsWith("invite-closed"));

    // 확인 숫자를 보고 거절(= 새 코드 만들기)하면 입력한 쪽은 "없는 코드"를 보게 되고 기다림이 끝난다
    const rejected = await a.createInvite();
    await b.acceptInvite(rejected.code);
    await a.createInvite();
    await assert.rejects(api.getInvite(rejected.code), rejectsWith("unknown-invite"));
    // 수락만 되고 승인이 안 된 채 만료되면 "만료"
    const stale = await b.createInvite();
    await a.acceptInvite(stale.code);
    await service.demoAdvance(11 * MINUTE);
    assert.equal((await api.getInvite(stale.code)).status, "expired");
    await assert.rejects(b.confirmInvite(await api.getInvite(stale.code)), rejectsWith("invite-not-accepted"));

    await connect(api, a, b);
    const again = await a.createInvite();
    await b.acceptInvite(again.code);
    const failed = await a.confirmInvite(await api.getInvite(again.code));
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /하나뿐/);
  });
});

describe("앱 — 평가: 휴대폰에서 봉인, 서버는 평문을 못 본다", () => {
  async function scene() {
    const s = setup({ batchSize: 2 });
    const [a, b, c] = [await s.client(), await s.client(), await s.client()];
    const ab = await connect(s.api, a, b);
    const cb = await connect(s.api, c, b);
    await s.service.demoAdvance(31 * DAY);
    return { ...s, a, b, c, ab, cb };
  }

  it("라운드 공개키로 봉인한 평가가 공개 시각에 열려 받는 사람 화면에 묶음으로 뜬다", async () => {
    const { service, a, b, c, ab, cb } = await scene();
    const sa = await a.startReview(ab, { stance: "endorse", text: "약속 시간 정확" });
    const sc = await c.startReview(cb, { stance: "neutral", text: "연락이 가끔 늦다" });
    await service.demoAdvance(MINUTE);
    await a.refresh();
    await c.refresh();
    assert.ok(a.slotOf(ab)?.record.sealedRound, "지연이 정해지면 봉인된다");
    assert.equal((await b.api.profile(b.pub)).batches.length, 0, "공개 전엔 아무것도 안 보인다");
    const last = Math.max((await service.schedule(sa))!.revealAt, (await service.schedule(sc))!.revealAt);
    await service.demoAdvance(last - service.clock.now() + DAY);
    const v = await b.api.profile(b.pub);
    assert.deepEqual(v.batches.flat().map((i) => i.text).sort(), ["약속 시간 정확", "연락이 가끔 늦다"]);
  });

  it("봉인이 끝날 때까지 기다려서, 쓰자마자 시간을 크게 감아도 평가가 사라지지 않는다 (실시간 비콘 몇 초 대기)", async () => {
    const { service, a, b, c, ab, cb } = await scene();
    const timer = setInterval(() => void service.tick(), 200);
    try {
      await a.startReview(ab, { stance: "endorse", text: "기다려서 봉인" }, { waitMs: 10_000 });
      assert.ok(a.slotOf(ab)?.record.sealedRound, "등록 직후 그 자리에서 봉인까지");
      await c.startReview(cb, { stance: "endorse", text: "나중에 봉인" });
      assert.equal(await c.sealPending(10_000), 0, "밀린 봉인도 처리");
      await service.demoAdvance(120 * DAY); // 그사이 refresh 는 한 번도 안 부른다
      const texts = (await b.api.profile(b.pub)).batches.flat().map((i) => i.text);
      assert.deepEqual(texts.sort(), ["기다려서 봉인", "나중에 봉인"]);
    } finally {
      clearInterval(timer);
    }
  });

  it("관계당 평가는 한 번뿐이다", async () => {
    const { a, ab } = await scene();
    await a.startReview(ab, { stance: "endorse", text: "좋음" });
    await assert.rejects(a.startReview(ab, { stance: "endorse", text: "또" }), /이미/);
  });

  it("수정 창이 열리면 앱이 알아서 한 번 위장 수정하고, 직접 고치면 마지막 것만 공개된다", async () => {
    const { service, a, b, c, ab, cb } = await scene();
    const sa = await a.startReview(ab, { stance: "endorse", text: "처음 쓴 말" });
    await c.startReview(cb, { stance: "endorse", text: "다른 사람 평가" });
    await service.demoAdvance(MINUTE);
    await a.refresh();
    await c.refresh();
    const sch = (await service.schedule(sa))!;
    await service.demoAdvance(sch.editOpensAt - service.clock.now() + MINUTE);
    const tasks = await a.refresh();
    assert.ok(tasks.some((t) => t.kind === "edit" && t.slotId === sa));
    assert.equal(a.slotOf(ab)?.record.touchedInWindow, true, "위장 수정 완료");
    await a.edit(sa, { stance: "neutral", text: "다시 생각해 보니 그저 그렇다" });
    await service.demoAdvance(120 * DAY);
    const texts = (await b.api.profile(b.pub)).batches.flat().map((i) => i.text);
    assert.ok(texts.includes("다시 생각해 보니 그저 그렇다") && !texts.includes("처음 쓴 말"));
  });

  it("1년 뒤 재확인 요청이 오고, 서명하면 커브의 1년 칸에 반영된다", async () => {
    const { service, a, b, c, ab, cb } = await scene();
    await a.startReview(ab, { stance: "endorse", text: "a" });
    await c.startReview(cb, { stance: "endorse", text: "c" });
    await service.demoAdvance(MINUTE);
    await a.refresh();
    await c.refresh();
    await service.demoAdvance(120 * DAY);
    for (let i = 0; i < 40; i++) {
      await service.demoAdvance(10 * DAY);
      for (const who of [a, c]) for (const t of await who.refresh()) if (t.kind === "reaffirm") await who.reaffirm(t.slotId, t.checkpoint);
      if ((await b.api.profile(b.pub)).curve[1]!.total === 2) break;
    }
    const v = await b.api.profile(b.pub);
    assert.deepEqual([v.curve[1]!.kept, v.curve[1]!.total], [2, 2]);
  });
});

describe("앱 — 데모 가상 친구", () => {
  it("가상 친구 4명과 연결하고 시간을 감으면, 친구들이 써 준 평가가 묶음으로 열린다", async () => {
    const { api, client, service } = setup();
    const me = await client();
    for (let i = 0; i < 2; i++) {
      const botInvite = await api.demoBotInvite();
      const { view } = await me.acceptInvite(botInvite.code);
      assert.equal(view.status, "done", "가상 친구는 바로 승인한다");
      await me.remember(view);
    }
    for (let i = 0; i < 2; i++) {
      const mine = await me.createInvite();
      await api.demoBotJoin(mine.code);
      await me.confirmInvite(await api.getInvite(mine.code));
    }
    assert.equal(me.contacts().length, 4);
    await service.demoAdvance(200 * DAY);
    const v = await api.profile(me.pub);
    assert.equal(v.batches.length, 1);
    assert.equal(v.batches[0]!.length, 4);
  });

  it("실서버 모드에선 데모 기능이 꺼져 있다", async () => {
    const api = localApi(new AppService({ demo: false, seed: "real" }));
    await assert.rejects(api.demoAdvance(DAY), rejectsWith("demo-only"));
    await assert.rejects(api.demoBotInvite(), rejectsWith("demo-only"));
    assert.equal((await api.info()).demo, false);
  });
});

describe("앱 — 기기 저장소", () => {
  it("백업 문자열로 같은 키를 되살린다", async () => {
    const { api, client } = setup();
    const a = await client();
    const restored = await PatinaClient.open(api, memoryStore(), a.exportSeed());
    assert.equal(restored.pub, a.pub);
    await assert.rejects(PatinaClient.open(api, memoryStore(), "not-a-seed"), /형식/);
  });

  it("서버가 초기화되면(데모 재시작) 이 기기의 관계를 정리하고 알린다", async () => {
    const first = setup();
    const store = memoryStore();
    const a = await PatinaClient.open(first.api, store);
    await connect(first.api, a, await first.client());
    const fresh = localApi(new AppService({ demo: true, seed: "other" }));
    const reopened = await PatinaClient.open(fresh, store);
    assert.equal(reopened.pub, a.pub, "키는 그대로");
    assert.equal(reopened.serverWasReset, true);
    assert.equal(reopened.contacts().length, 0);
  });
});

describe("앱 — HTTP 서버", () => {
  it("HTTP 로도 똑같이 연결되고, 오류는 코드·메시지로 돌아온다", async () => {
    const service = new AppService({ demo: true, seed: "http" });
    const server = createPatinaServer(service);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const api = httpApi(base);
      assert.equal((await api.info()).demo, true);
      await assert.rejects(api.getInvite("ZZZZZZ"), rejectsWith("unknown-invite"));
      const [a, b] = [await PatinaClient.open(api, memoryStore()), await PatinaClient.open(api, memoryStore())];
      const id = await connect(api, a, b);
      assert.ok(service.engine.relationshipRecord(id));
      assert.equal((await fetch(`${base}/api/nope`, { method: "POST", body: "[]" })).status, 404);
      assert.equal((await fetch(`${base}/api/info`, { method: "POST", body: "{bad" })).status, 400);
      assert.equal((await fetch(`${base}/api/demoAdvance`, { method: "POST", body: JSON.stringify([10 * YEAR]) })).status, 400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
