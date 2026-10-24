// 밖으로 나가는 화면 데이터 (v2 PWA 가 그대로 받아 그리는 계약).
// 대상 본인과 제3자가 보는 화면은 같은 ProfileView 하나다: "받는 사람이 못 보는 건 아무도 못 본다".

import { MONTH, YEAR } from "./time.js";

export interface PublishedItem {
  readonly stance: "endorse" | "neutral";
  readonly text: string;
}

export interface RetentionPoint {
  readonly label: string;
  /** 3개월 지점: 지지 수 / 공개된 평가 수. 1년·3년 지점: 재확인 수 / 그 시점 결과가 공개된 지지 수. */
  readonly kept: number;
  readonly total: number;
  readonly rate: number | null;
}

export interface ProfileView {
  readonly subject: string;
  /** 살아 있는 지지 가중치 합 − 공개된 경고 가중치 합. 고정 주기 또는 묶음 공개 때만 바뀐다. */
  readonly score: number;
  readonly curve: readonly RetentionPoint[];
  /** 묶음별 평가. 묶음 안은 섞여 있고 날짜·순서·작성자가 없다. */
  readonly batches: readonly (readonly PublishedItem[])[];
  /** 6개월 넘게 묶음이 안 찬 평가들의 집계 (원문 없음). */
  readonly aggregates: readonly { readonly endorse: number; readonly neutral: number }[];
  /** k 명 이상 모여 공개된 경고 묶음. */
  readonly warnings: readonly (readonly string[])[];
}

/** 평가자 본인만 보는 할 일. 슬롯 id(작성자만 아는 값)로만 조회된다. */
export type ReviewerTask =
  | { readonly kind: "edit"; readonly slotId: string; readonly opensAt: number; readonly closesAt: number }
  | { readonly kind: "reaffirm"; readonly slotId: string; readonly checkpoint: number; readonly label: string; readonly deadline: number };

export function durationLabel(ms: number): string {
  if (ms % YEAR === 0) return `${ms / YEAR}년`;
  return `${Math.round(ms / MONTH)}개월`;
}

export function emptyView(subject: string, labels: readonly string[]): ProfileView {
  return {
    subject,
    score: 0,
    curve: labels.map((label) => ({ label, kept: 0, total: 0, rate: null })),
    batches: [],
    aggregates: [],
    warnings: [],
  };
}

export function renderCurve(view: ProfileView, title?: string, width = 20): string {
  const lines = [`신뢰 리텐션 커브 — ${title ?? view.subject.slice(0, 8)}`];
  for (const p of view.curve) {
    const bar =
      p.rate === null ? "·".repeat(width) : "█".repeat(Math.round(p.rate * width)).padEnd(width, "░");
    const pct = p.rate === null ? "  - " : `${Math.round(p.rate * 100)}%`.padStart(4);
    lines.push(`  ${p.label.padEnd(4, "　")} ${bar} ${pct}  (n=${p.total})`);
  }
  const warned = view.warnings.reduce((s, w) => s + w.length, 0);
  lines.push(
    `  점수 ${view.score.toFixed(2)} · 공개 묶음 ${view.batches.length} · 집계 ${view.aggregates.length} · 공개 경고 ${warned}`,
  );
  return lines.join("\n");
}
