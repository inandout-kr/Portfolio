// 뮤테이션 점검: 엔진의 핵심 규칙을 하나씩 일부러 망가뜨려서 테스트가 실패하는지 본다.
// "테스트 전부 통과"가 진짜 보장인지 확인하는 장치. 하나라도 '안 잡힘'이면 그 규칙의 테스트가 비어 있다.
//
//   npm run mutate            # 전부
//   npm run mutate -- M5 M17  # 일부만
//
// 원본은 메모리에 들고 있다가 끝나면(실패·중단 포함) 반드시 되돌린다.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "src/engine.ts";

/** [이름, 원본 조각, 망가뜨린 조각]. 원본 조각은 파일에 정확히 한 번 나와야 한다. */
const MUTATIONS = [
  ["M1 해제 때 화면 재계산 (규칙 5)",
    "        st.pool.push({ slot, stance: content.stance, text: content.text, unsealedAt: now });",
    "        st.pool.push({ slot, stance: content.stance, text: content.text, unsealedAt: now });\n        touched.add(slot.subject);"],
  ["M2 숙성 안 따지고 n 카운트 (규칙 6)", "st.pool.filter((p) => p.slot.eligible).length", "st.pool.length"],
  ["M3 경고를 묶음 풀에 섞기 (규칙 10)", 'if (content.stance === "warn") {', 'if (content.stance === "warn" && false) {'],
  ["M4 경고 임계 1 (규칙 10)", ".size >= cfg.warningThreshold", ".size >= 1"],
  ["M5 묶음 셔플 안 함 (규칙 4)",
    "st.batches.push(shuffle(st.pool.map((p) => ({ stance: p.stance, text: p.text })), this.#rng));",
    "st.batches.push(st.pool.map((p) => ({ stance: p.stance, text: p.text })));"],
  ["M6 지연을 이미 공개된 라운드로 (규칙 2)", "delayRound: this.#beacon.roundAt(now) + 1,", "delayRound: this.#beacon.roundAt(now),"],
  ["M7 수정 창 무시 (규칙 3)", "if (slot.box && now < slot.schedule.editOpensAt) {", "if (false) {"],
  ["M8 재확인 결과 즉시 반영 (규칙 5·7)",
    "if (st.outcomes.length < cfg.batchSize && oldest + cfg.aggregateAfter > now) continue;", ""],
  ["M9 매 tick 화면 갱신 (규칙 5)", "if (epoch !== this.#refreshEpoch) {", "if (true) {"],
  ["M10 집계 폴백 없음 (규칙 11)",
    "} else if (Math.min(...st.pool.map((p) => p.unsealedAt)) + cfg.aggregateAfter <= now) {", "} else if (false) {"],
  ["M11 같은 쌍 관계 중복 허용 (규칙 1)", "if (this.#pairTags.has(pairTag)) throw", "if (false) throw"],
  ["M12 주간 관계 상한 없음 (가짜 계정)",
    "if (this.#recentFor(p, now).length >= this.config.maxNewRelationshipsPerWeek) {", "if (false) {"],
  ["M13 공개된 경고가 점수에 영향 없음 (규칙 10)",
    "for (const s of st.disclosedWarners) score -= weightOf(s, 0, now);", ""],
  ["M14 재등록 허용 (규칙 2)",
    'if (this.#nullifiers.has(v.nullifier)) throw new ProtocolError("already-registered"',
    'if (false) throw new ProtocolError("already-registered"'],
  ["M15 깨진 봉인에서 예외 전파",
    "      if (e instanceof BeaconNotReadyError) return NOT_READY;\n      return null;", "      throw e;"],
  ["M16 관계 나이를 보증 시점이 아닌 지금 기준으로 (규칙 9)",
    "relationshipAge: this.#relationshipAge(s.relationshipId, affirmedAt),",
    "relationshipAge: this.#relationshipAge(s.relationshipId, now),"],
  ["M17 재확인 보너스 없음 (규칙 7·9)", "o.e.shownLevel = o.checkpoint + 1;", "o.e.shownLevel = 0;"],
  ["M18 늦게 도착한 비콘에 tick 중단 (v2 준비)",
    "        if (e instanceof BeaconNotReadyError) continue; // 실제 비콘은",
    "        throw e; // 실제 비콘은"],
];

const only = process.argv.slice(2);
const original = readFileSync(SRC, "utf8");
const restore = () => writeFileSync(SRC, original);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

let survived = 0;
try {
  for (const [name, from, to] of MUTATIONS) {
    if (only.length && !only.some((o) => name.startsWith(o + " "))) continue;
    const count = original.split(from).length - 1;
    if (count !== 1) throw new Error(`${name}: 원본 조각이 ${count}번 나온다 (엔진이 바뀌었으면 이 목록도 고쳐라)`);
    writeFileSync(SRC, original.replace(from, to));
    const r = spawnSync("npx tsc -p . && node --test --test-reporter=dot 'dist/test/**/*.test.js'", {
      shell: true,
      encoding: "utf8",
    });
    const caught = r.status !== 0;
    if (!caught) survived += 1;
    console.log(`${caught ? "잡힘   " : "안 잡힘"}  ${name}`);
  }
} finally {
  restore();
  spawnSync("npx tsc -p .", { shell: true });
}
console.log(survived === 0 ? "\n모든 뮤테이션이 테스트에 잡혔다." : `\n${survived}개가 살아남았다 — 해당 규칙 테스트를 보강할 것.`);
process.exit(survived === 0 ? 0 : 1);
