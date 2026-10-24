// 묵은지 시뮬레이션. 가상 시계로 2026-11-01 부터 하루씩 돌린다.
//   0~3년   : 활동기 — 사람들이 만나고, 겪어보고, 평가하고, 재확인한다.
//   3~4.5년 : 숙성기 — 새 관계 없이 시간만 흐른다. "3년 재확인"은 공개 후 3년이 지나야 생기는 값이라
//             3년 시점엔 원리상 비어 있다. 그걸 채우려면 시간을 더 흘리는 수밖에 없다 (이게 핵심).
// 같은 시드면 출력이 매번 똑같다 (README 의 결과가 그대로 재현된다).
//
// 등장인물
//   지은  — 약속을 지키는 사람. 관계 맺은 사람 대부분이 1년·3년 뒤에도 다시 믿는다.
//   민수  — 괜찮지만 들쭉날쭉. 지지 70%, 재확인도 절반 남짓.
//   한탕  — 초반엔 그럴듯하다가 먹튀. 피해자 절반이 경고(warn)를 쓴다.
//   공장  — 1년 차에 가짜 계정 60개를 6주 동안 찍어내 전부 지지·전부 재확인.
//   커뮤니티 150명 — 서로도 만나고 보증한다 (그래서 이들의 보증엔 standing 이 붙는다).

import {
  DAY,
  Member,
  SeededRandom,
  World,
  randomFloat,
  randomInt,
  renderCurve,
  type ProfileView,
  type ReviewContent,
} from "../src/index.js";

const ACTIVE_DAYS = 3 * 365;
const TOTAL_DAYS = Math.round(4.5 * 365);

const w = new World({ seed: "mukeunji-demo" });
const rng = new SeededRandom("mukeunji-demo/decisions");
const chance = (p: number) => randomFloat(rng) < p;
const pick = <T>(xs: readonly T[]): T => xs[randomInt(rng, xs.length)]!;
const say = (stance: ReviewContent["stance"], texts: readonly string[]): ReviewContent => ({ stance, text: pick(texts) });

const TEXT = {
  jieunGood: ["약속 시간 정확", "빌린 책을 제때 돌려줌", "어려울 때 먼저 연락해 줌", "거래 설명이 사진과 똑같았다", "스터디 자료를 늘 먼저 공유"],
  minsuGood: ["재밌고 도움 됨", "부탁하면 들어준다", "거래 깔끔"],
  minsuMeh: ["연락이 가끔 끊긴다", "약속을 한 번 미뤘다", "나쁘진 않은데 기복이 있다"],
  scamWarn: ["선입금 받고 잠수", "돈을 안 갚았다", "물건이 설명과 전혀 달랐다", "같은 수법으로 여러 명에게 빌렸다고 들었다"],
  scamMeh: ["처음엔 친절했는데 요즘 연락이 안 된다"],
  scamGood: ["말을 참 잘한다"],
  fake: ["최고의 사람", "무조건 믿어도 됨"],
  peerGood: ["믿을 만함", "약속 잘 지킴", "도움 많이 받음"],
  peerMeh: ["평범"],
};

interface Persona {
  readonly name: string;
  readonly desc: string;
  readonly member: Member;
  readonly perMonth: number;
  readonly review: () => ReviewContent;
  /** 1년·3년 재확인 확률. */
  readonly keep: readonly [number, number];
}

/** 평가 하나의 생애: 만남 → (겪어보는 기간) → 등록 → 봉인 → 수정 창 → 재확인. */
interface Reviewer {
  readonly m: Member;
  readonly about: Member;
  readonly review: () => ReviewContent;
  readonly keep: readonly [number, number];
  readonly registerOn: number;
  slotId?: string;
  written?: boolean;
  readonly decided: Set<string>;
}

const community = Array.from({ length: 150 }, () => w.member());
const persona = (name: string, desc: string, perMonth: number, review: () => ReviewContent, keep: [number, number]): Persona => ({
  name,
  desc,
  member: w.member(),
  perMonth,
  review,
  keep,
});
const people: Persona[] = [
  persona("지은", "약속을 지키는 사람", 3, () => say("endorse", TEXT.jieunGood), [0.92, 0.9]),
  persona("민수", "괜찮지만 들쭉날쭉", 3, () => (chance(0.7) ? say("endorse", TEXT.minsuGood) : say("neutral", TEXT.minsuMeh)), [0.6, 0.55]),
  persona(
    "한탕",
    "초반에 잘해주다 먹튀",
    3,
    () => (chance(0.5) ? say("warn", TEXT.scamWarn) : chance(0.6) ? say("neutral", TEXT.scamMeh) : say("endorse", TEXT.scamGood)),
    [0.1, 0.05],
  ),
];
const factory = persona("공장", "가짜 계정 60개 (1년 차, 6주간)", 0, () => say("endorse", TEXT.fake), [1, 1]);
const everyone = [...people, factory];

const reviewers: Reviewer[] = [];
const related = new Set<string>();
const pairKey = (a: Member, b: Member) => [a.pub, b.pub].sort().join(":");
let fakes = 0;

function meet(a: Member, b: Member): boolean {
  if (a === b || related.has(pairKey(a, b))) return false;
  Member.befriend(a, b);
  related.add(pairKey(a, b));
  return true;
}

async function day(d: number): Promise<void> {
  if (d < ACTIVE_DAYS && d % 30 === 0) {
    // 매달: 주인공들이 커뮤니티에서 새 사람을 만나고, 겪어본 뒤(35~100일) 평가를 등록한다.
    for (const p of people) {
      for (let i = 0; i < p.perMonth; i++) {
        let partner = pick(community);
        while (!meet(p.member, partner)) partner = pick(community);
        reviewers.push({ m: partner, about: p.member, review: p.review, keep: p.keep, registerOn: d + 35 + randomInt(rng, 66), decided: new Set() });
      }
    }
    // 커뮤니티끼리도 15쌍이 만나 서로 평가한다.
    for (let i = 0; i < 15; i++) {
      const [a, b] = [pick(community), pick(community)];
      if (!meet(a, b)) continue;
      const peer = () => (chance(0.85) ? say("endorse", TEXT.peerGood) : say("neutral", TEXT.peerMeh));
      for (const [x, y] of [[a, b], [b, a]] as const) {
        reviewers.push({ m: x, about: y, review: peer, keep: [0.75, 0.7], registerOn: d + 35 + randomInt(rng, 66), decided: new Set() });
      }
    }
  }
  // 1년 차: 공장이 일주일에 10개씩 6주 동안 가짜 계정을 찍고, 관계 맺은 그날 바로 지지 등록
  if (d >= 365 && d < 365 + 42 && (d - 365) % 7 === 0) {
    for (let i = 0; i < 10; i++) {
      const fake = w.member();
      meet(factory.member, fake);
      fakes += 1;
      reviewers.push({ m: fake, about: factory.member, review: factory.review, keep: factory.keep, registerOn: d, decided: new Set() });
    }
  }

  for (const r of reviewers) {
    if (!r.slotId) {
      if (d >= r.registerOn) r.slotId = r.m.register(r.about.pub);
      continue; // 지연은 다음 비콘 라운드가 나와야 정해지니 내용은 다음 날 봉인
    }
    if (!r.written && w.engine.schedule(r.slotId)) {
      await r.m.write(r.slotId, r.review());
      r.written = true;
    }
    for (const t of r.m.tasks()) {
      if (t.slotId !== r.slotId) continue; // 한 사람이 여러 평가를 갖고 있다
      const key = t.kind === "reaffirm" ? `reaffirm:${t.checkpoint}` : "edit";
      if (r.decided.has(key)) continue;
      r.decided.add(key);
      if (t.kind === "edit") await r.m.coverEdit(t.slotId); // 클라이언트 기본 동작: 수정 창마다 위장 수정
      if (t.kind === "reaffirm" && chance(r.keep[t.checkpoint as 0 | 1])) r.m.reaffirm(t.slotId, t.checkpoint);
    }
  }
}

const columns = [6, 12, 18, 24, 30, 36, 42, 48, 54];
const history = new Map<string, number[]>(everyone.map((p) => [p.name, []]));
const start = w.clock.now();
let threeYearSnapshot = new Map<string, ProfileView>();

for (let d = 0; d < TOTAL_DAYS; d++) {
  await day(d);
  w.clock.setTo(start + (d + 1) * DAY);
  await w.tick();
  const elapsed = d + 1;
  for (const m of columns) {
    if (elapsed === Math.round((m / 12) * 365)) for (const p of everyone) history.get(p.name)!.push(w.engine.view(p.member.pub).score);
  }
  if (elapsed === ACTIVE_DAYS) threeYearSnapshot = new Map(everyone.map((p) => [p.name, w.engine.view(p.member.pub)]));
}

// ---------------------------------------------------------------- 출력

const v = (p: Persona): ProfileView => w.engine.view(p.member.pub);
const fmt = (x: number) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2).padStart(7);
/** 한글은 터미널에서 두 칸이라 padStart 로는 열이 안 맞는다. */
const padCells = (s: string, width: number) => " ".repeat(Math.max(0, width - [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0))) + s;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const written = reviewers.filter((r) => r.written).length;
const rootSizes = new Set(w.chain.payloads.map((p) => p.length));

console.log(`묵은지 시뮬레이션 — 가상 시계 ${iso(start)} → ${iso(w.clock.now())} (하루 단위 tick ${TOTAL_DAYS}회)`);
console.log(`  0~3년 활동기 · 3~4.5년 숙성기(새 관계 없음)`);
console.log(
  `  사용자 ${community.length + everyone.length + fakes}명 · 관계 ${related.size}개 · 봉인 평가 ${written}건 · ` +
    `체인 기록 ${w.chain.payloads.length}회 (${rootSizes.size === 1 && rootSizes.has(32) ? "전부 32바이트 머클루트" : "?"})`,
);

console.log("\n[1] 시간에 따른 점수 — 시간이 재료라서 처음 1년은 모두 0 근처");
console.log(`      ${columns.map((m) => padCells(`${m}개월`, 7)).join(" ")}`);
for (const p of everyone) console.log(`  ${p.name}${history.get(p.name)!.map(fmt).join(" ")}`);

console.log("\n[2] 신뢰 리텐션 커브 (별점 없음)");
const jieun3y = threeYearSnapshot.get("지은")!.curve.at(-1)!;
console.log(`  3년 시점엔 '3년' 칸이 비어 있었다 (지은 n=${jieun3y.total}) — 3년 리텐션은 3년이 지나야 생긴다. 아래는 4.5년 시점.\n`);
for (const p of everyone) console.log(renderCurve(v(p), `${p.name} · ${p.desc}`) + "\n");

console.log("[3] 지은이 받은 마지막 묶음 — 섞여 있고 작성자·날짜가 없다");
for (const i of v(people[0]!).batches.at(-1)!) console.log(`  · [${i.stance === "endorse" ? "지지" : "중립"}] ${i.text}`);

const scam = v(people[2]!);
console.log(`\n[4] 한탕의 공개된 경고 — 서로 다른 관계 3명이 모일 때마다 묶음째 공개 (${scam.warnings.length}묶음)`);
for (const group of scam.warnings.slice(0, 2)) console.log(`  · ${group.join(" / ")}`);

const f = v(factory);
const jieun = v(people[0]!);
console.log("\n[5] 가짜 계정 공장");
console.log(`  가짜 지지 ${f.aggregates.reduce((s, a) => s + a.endorse, 0)}건 전부 숙성 안 된 관계 → 묶음 공개 ${f.batches.length}회, 6개월 뒤 집계로만 ${f.aggregates.length}회`);
console.log(`  만난 날 쓴 보증은 무게 0 → 공장 점수는 1년 재확인 전까지 0 (12·18·24개월 칸)`);
console.log(`  4.5년 점수: 공장 ${fmt(f.score).trim()} vs 지은 ${fmt(jieun.score).trim()} — 3년 재확인까지 다 버텨도 이 정도.`);
console.log(`  가짜 계정은 아무도 보증해 주지 않아 standing 바닥(0.2)에 묶이고, 커브는 사람에게 없는 100/100/100 이다.`);
console.log(`  한계: 가짜끼리 서로 보증하면 standing 도 오른다 → 군집 탐지(시드 기반 신뢰 전파)는 v2 과제.`);
