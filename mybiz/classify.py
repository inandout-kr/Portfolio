"""
mybiz/classify.py
=================
원본 거래 → 분개. 우선순위:
  1) 수동 지정(override)          — 사용자가 직접 찍은 계정
  2) 내부이체 짝짓기              — 내 계정 A −x, 내 계정 B +x (±N일) → 한 건의 이체 분개
  3) 키워드 규칙                  — 적요에 키워드가 있으면 그 계정 (첫 매칭 우선)
  4) 미분류                       — 수익:미분류 / 비용:미분류 → review 대상

규칙의 대상이 자산/부채 계정이면 손익이 아닌 이체로 처리된다
(예: "신한카드" → "부채:카드:신한" = 카드대금 결제. 카드 사용분은 이미 비용으로 잡혔으므로
 결제를 또 비용으로 잡으면 이중 계상).
"""
from __future__ import annotations

from dataclasses import dataclass

from .model import (
    UNCATEGORIZED_IN,
    UNCATEGORIZED_OUT,
    JournalEntry,
    Posting,
    RawTxn,
    account_type,
)


@dataclass(frozen=True)
class Rule:
    keyword: str
    account: str
    direction: str = "any"  # "in" | "out" | "any"

    def __post_init__(self):
        account_type(self.account)
        if self.direction not in ("in", "out", "any"):
            raise ValueError(f"direction 은 in/out/any: {self.direction!r}")

    def matches(self, txn: RawTxn) -> bool:
        if self.direction == "in" and txn.amount < 0:
            return False
        if self.direction == "out" and txn.amount > 0:
            return False
        return self.keyword.lower() in txn.description.lower()


def pair_transfers(txns: list[RawTxn], window_days: int = 2,
                   exclude: set[str] = frozenset()) -> list[tuple[RawTxn, RawTxn]]:
    """서로 다른 내 계정 사이 반대부호·동일금액·N일 이내 거래를 짝짓는다 (탐욕, 날짜 가까운 순)."""
    pool = sorted((t for t in txns if t.id not in exclude), key=lambda t: (t.date, t.id))
    used: set[str] = set()
    pairs = []
    for a in pool:
        if a.id in used or a.amount >= 0:
            continue
        best = None
        for b in pool:
            if (b.id in used or b.source == a.source or b.amount != -a.amount
                    or abs((b.date - a.date).days) > window_days):
                continue
            gap = abs((b.date - a.date).days)
            if best is None or gap < best[0]:
                best = (gap, b)
        if best:
            used.update((a.id, best[1].id))
            pairs.append((a, best[1]))
    return pairs


def classify(txns: list[RawTxn], rules: list[Rule], overrides: dict[str, str] | None = None,
             window_days: int = 2) -> list[JournalEntry]:
    overrides = overrides or {}
    entries: list[JournalEntry] = []
    for t in txns:
        if t.id in overrides:
            entries.append(_single(t, overrides[t.id], "수동"))
    manual = set(overrides)
    paired: set[str] = set()
    for a, b in pair_transfers(txns, window_days, exclude=manual):
        paired.update((a.id, b.id))
        entries.append(JournalEntry(
            date=min(a.date, b.date),
            memo=f"이체: {a.description or a.source} → {b.description or b.source}",
            postings=[Posting(a.source, a.amount), Posting(b.source, b.amount)],
            txn_ids=(a.id, b.id)))
    for t in txns:
        if t.id in manual or t.id in paired:
            continue
        rule = next((r for r in rules if r.matches(t)), None)
        if rule:
            entries.append(_single(t, rule.account, rule.keyword))
        else:
            entries.append(_single(t, UNCATEGORIZED_IN if t.amount > 0 else UNCATEGORIZED_OUT, "미분류"))
    entries.sort(key=lambda e: (e.date, e.memo))
    return entries


def _single(t: RawTxn, counter: str, why: str) -> JournalEntry:
    return JournalEntry(date=t.date, memo=t.description or why,
                        postings=[Posting(t.source, t.amount), Posting(counter, -t.amount)],
                        txn_ids=(t.id,))
