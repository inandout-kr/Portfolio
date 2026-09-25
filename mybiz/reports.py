"""
mybiz/reports.py
================
사업체식 보고서.
  - income_statement : 손익계산서 (수익 − 비용 = 순이익, 순이익률 = 저축률)
  - balance_sheet    : 재무상태표 (자산 − 부채 = 순자산 = 기초순자산 + 누적이익)
  - monthly          : 월별 실적 (수익/비용/순이익/저축률)
  - budget_variance  : 예산 대비 실적
  - runway_months    : 런웨이 — 수입이 끊겨도 현금성 자산으로 버티는 개월 수
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from .model import (
    CREDIT_NORMAL,
    OPENING_EQUITY,
    AccountType,
    JournalEntry,
    Posting,
    account_type,
)


def opening_entry(balances: dict[str, int], on: date) -> JournalEntry | None:
    """기초잔액(자산 +, 부채 −) → 기초순자산 대변으로 맞춘 분개."""
    posts = [Posting(a, v) for a, v in balances.items() if v]
    if not posts:
        return None
    posts.append(Posting(OPENING_EQUITY, -sum(p.amount for p in posts)))
    return JournalEntry(date=on, memo="기초잔액", postings=posts)


def balances(entries: list[JournalEntry], start: date | None = None,
             end: date | None = None) -> dict[str, int]:
    """[start, end] 기간 계정별 잔액 (원시 부호: 차변 +)."""
    out: dict[str, int] = defaultdict(int)
    for e in entries:
        if (start and e.date < start) or (end and e.date > end):
            continue
        for p in e.postings:
            out[p.account] += p.amount
    return dict(out)


def shown(account: str, raw: int) -> int:
    """보고서 표시용 — 대변 정상계정은 부호를 뒤집어 양수로."""
    return -raw if account_type(account) in CREDIT_NORMAL else raw


def _by_type(bal: dict[str, int], t: AccountType) -> dict[str, int]:
    return {a: shown(a, v) for a, v in sorted(bal.items()) if account_type(a) is t and v}


@dataclass
class IncomeStatement:
    start: date
    end: date
    revenue: dict[str, int]
    expense: dict[str, int]

    @property
    def total_revenue(self) -> int:
        return sum(self.revenue.values())

    @property
    def total_expense(self) -> int:
        return sum(self.expense.values())

    @property
    def net_income(self) -> int:
        return self.total_revenue - self.total_expense

    @property
    def margin(self) -> float | None:
        """순이익률 = 저축률."""
        return self.net_income / self.total_revenue if self.total_revenue else None


def income_statement(entries, start: date, end: date) -> IncomeStatement:
    bal = balances(entries, start, end)
    return IncomeStatement(start, end, _by_type(bal, AccountType.REVENUE),
                           _by_type(bal, AccountType.EXPENSE))


@dataclass
class BalanceSheet:
    as_of: date
    assets: dict[str, int]
    liabilities: dict[str, int]
    opening_equity: int
    retained_earnings: int

    @property
    def total_assets(self) -> int:
        return sum(self.assets.values())

    @property
    def total_liabilities(self) -> int:
        return sum(self.liabilities.values())

    @property
    def net_worth(self) -> int:
        return self.total_assets - self.total_liabilities


def balance_sheet(entries, as_of: date) -> BalanceSheet:
    bal = balances(entries, end=as_of)
    rev = sum(_by_type(bal, AccountType.REVENUE).values())
    exp = sum(_by_type(bal, AccountType.EXPENSE).values())
    eq = sum(_by_type(bal, AccountType.EQUITY).values())
    bs = BalanceSheet(as_of, _by_type(bal, AccountType.ASSET),
                      _by_type(bal, AccountType.LIABILITY), eq, rev - exp)
    # 복식부기 항등식: 자산 − 부채 = 자본 + 누적이익
    assert bs.net_worth == eq + bs.retained_earnings, "대차대조 불일치"
    return bs


def month_range(ym: str) -> tuple[date, date]:
    y, m = map(int, ym.split("-"))
    start = date(y, m, 1)
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return start, date.fromordinal(nxt.toordinal() - 1)


def months_in(entries) -> list[str]:
    return sorted({e.date.strftime("%Y-%m") for e in entries if e.memo != "기초잔액"})


def monthly(entries) -> list[tuple[str, IncomeStatement]]:
    return [(ym, income_statement(entries, *month_range(ym))) for ym in months_in(entries)]


def budget_variance(stmt: IncomeStatement, budget: dict[str, int]) -> list[tuple[str, int, int, int]]:
    """(계정, 예산, 실적, 잔여) — 비용 계정은 예산−실적, 수익 계정은 실적−예산 (양수 = 유리)."""
    rows = []
    for acct, plan in budget.items():
        if account_type(acct) is AccountType.REVENUE:
            actual = stmt.revenue.get(acct, 0)
            rows.append((acct, plan, actual, actual - plan))
        else:
            actual = stmt.expense.get(acct, 0)
            rows.append((acct, plan, actual, plan - actual))
    return rows


def runway_months(entries, as_of: date, cash_prefixes: tuple[str, ...] = ("자산:통장", "자산:현금"),
                  lookback: int = 3) -> float | None:
    """현금성 자산 ÷ 최근 N개월 평균 비용. 비용 이력이 없으면 None."""
    bs = balance_sheet(entries, as_of)
    cash = sum(v for a, v in bs.assets.items() if a.startswith(cash_prefixes))
    recent = [s for ym, s in monthly(entries) if month_range(ym)[1] <= as_of][-lookback:]
    if not recent:
        return None
    burn = sum(s.total_expense for s in recent) / len(recent)
    return cash / burn if burn else None
