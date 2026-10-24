import { DAY, MINUTE, Member, type ReviewContent, type World } from "../src/index.js";

export const endorse = (text: string): ReviewContent => ({ stance: "endorse", text });
export const neutral = (text: string): ReviewContent => ({ stance: "neutral", text });
export const warn = (text: string): ReviewContent => ({ stance: "warn", text });

/** subject 와 관계를 맺은 새 사용자 n 명. 바로 공증한 뒤 age 만큼 묵힌다. */
export async function friendsOf(w: World, subject: Member, n: number, age = 31 * DAY): Promise<Member[]> {
  const out: Member[] = [];
  for (let i = 0; i < n; i++) {
    const m = w.member();
    Member.befriend(subject, m);
    out.push(m);
  }
  await w.tick();
  if (age > 0) await w.advance(age);
  return out;
}

/** 여러 명이 동시에 등록 → 지연 확정 → 봉인 제출. slotId 들을 순서대로 돌려준다. */
export async function reviewAll(
  w: World,
  subject: Member,
  entries: readonly (readonly [Member, ReviewContent | null])[],
): Promise<string[]> {
  const slots = entries.map(([m]) => m.register(subject.pub));
  w.clock.advance(MINUTE);
  await w.tick();
  for (const [i, [m, content]] of entries.entries()) {
    if (content) await m.write(slots[i]!, content);
  }
  return slots;
}

export function revealAt(w: World, slotId: string): number {
  const s = w.engine.schedule(slotId);
  if (!s) throw new Error("지연 미확정");
  return s.revealAt;
}

/** 주어진 슬롯이 전부 봉인 해제될 때까지 하루씩 흘린다. */
export async function untilRevealed(w: World, slotIds: readonly string[]): Promise<void> {
  const last = Math.max(...slotIds.map((s) => revealAt(w, s)));
  await w.advanceUntil(() => w.clock.now() >= last, 200 * DAY);
}

/** 테스트에서 화면 전체를 바이트 단위로 비교/검색하기 위한 직렬화. */
export function dump(value: unknown): string {
  return JSON.stringify(value);
}
