"""
mybiz/cli.py
============
사용법 (프로젝트 루트에서):
  python3 -m mybiz import 국민은행.csv --source 자산:통장:국민
  python3 -m mybiz import 신한카드.csv --source 부채:카드:신한
  python3 -m mybiz summary                  # 이번 달 대시보드
  python3 -m mybiz pl --month 2026-09       # 손익계산서 (--year 2026 도 가능)
  python3 -m mybiz bs                       # 재무상태표
  python3 -m mybiz monthly                  # 월별 실적
  python3 -m mybiz budget --month 2026-09   # 예산 대비 실적
  python3 -m mybiz review                   # 미분류 거래 목록
  python3 -m mybiz tag <거래ID> 비용:변동:식비
  python3 -m mybiz rule 올리브영 비용:변동:쇼핑 --direction out
"""
from __future__ import annotations

import argparse
from datetime import date

from . import reports
from .importers import load_csv
from .model import UNCATEGORIZED_IN, UNCATEGORIZED_OUT
from .store import Store


def won(v: int) -> str:
    return f"{v:>14,}원"


def _print_pl(s: reports.IncomeStatement) -> None:
    print(f"[손익계산서] {s.start} ~ {s.end}")
    print("  수익")
    for a, v in s.revenue.items():
        print(f"    {a:<28}{won(v)}")
    print(f"  {'수익 합계':<30}{won(s.total_revenue)}")
    print("  비용")
    for a, v in s.expense.items():
        print(f"    {a:<28}{won(v)}")
    print(f"  {'비용 합계':<30}{won(s.total_expense)}")
    print(f"  {'순이익':<31}{won(s.net_income)}")
    if s.margin is not None:
        print(f"  {'순이익률(저축률)':<27}{s.margin:>14.1%}")


def _print_bs(b: reports.BalanceSheet) -> None:
    print(f"[재무상태표] {b.as_of} 기준")
    print("  자산")
    for a, v in b.assets.items():
        print(f"    {a:<28}{won(v)}")
    print(f"  {'자산 합계':<30}{won(b.total_assets)}")
    print("  부채")
    for a, v in b.liabilities.items():
        print(f"    {a:<28}{won(v)}")
    print(f"  {'부채 합계':<30}{won(b.total_liabilities)}")
    print(f"  {'순자산':<31}{won(b.net_worth)}")
    print(f"    {'= 기초순자산':<27}{won(b.opening_equity)}")
    print(f"    {'+ 누적 순이익':<27}{won(b.retained_earnings)}")


def _period(args) -> tuple[date, date]:
    if getattr(args, "year", None):
        return date(args.year, 1, 1), date(args.year, 12, 31)
    return reports.month_range(args.month or date.today().strftime("%Y-%m"))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="mybiz", description="내 돈을 1인 사업체처럼 관리")
    sub = p.add_subparsers(dest="cmd", required=True)

    imp = sub.add_parser("import", help="CSV 거래내역 가져오기")
    imp.add_argument("path")
    imp.add_argument("--source", required=True, help="예: 자산:통장:국민 / 부채:카드:신한")

    for name in ("pl", "budget"):
        sp = sub.add_parser(name)
        sp.add_argument("--month")
        if name == "pl":
            sp.add_argument("--year", type=int)
    bs = sub.add_parser("bs")
    bs.add_argument("--date", type=date.fromisoformat, default=date.today())
    sub.add_parser("monthly")
    sub.add_parser("summary")
    sub.add_parser("review")
    tg = sub.add_parser("tag", help="거래 1건 수동 분류")
    tg.add_argument("txn_id")
    tg.add_argument("account")
    rl = sub.add_parser("rule", help="키워드 분류 규칙 추가")
    rl.add_argument("keyword")
    rl.add_argument("account")
    rl.add_argument("--direction", choices=("in", "out", "any"), default="any")

    args = p.parse_args(argv)
    st = Store()

    if args.cmd == "import":
        txns = load_csv(args.path, args.source)
        n = st.add_txns(txns)
        print(f"{len(txns)}건 읽음, 신규 {n}건 저장 ({len(txns) - n}건 중복 무시)")
        return 0
    if args.cmd == "tag":
        st.set_override(args.txn_id, args.account)
        print(f"{args.txn_id} → {args.account}")
        return 0
    if args.cmd == "rule":
        st.add_rule(args.keyword, args.account, args.direction)
        print(f"규칙 추가: '{args.keyword}' → {args.account} ({args.direction})")
        return 0

    j = st.journal()
    if args.cmd == "pl":
        _print_pl(reports.income_statement(j, *_period(args)))
    elif args.cmd == "bs":
        _print_bs(reports.balance_sheet(j, args.date))
    elif args.cmd == "monthly":
        print(f"{'월':<9}{'수익':>16}{'비용':>16}{'순이익':>16}{'저축률':>9}")
        for ym, s in reports.monthly(j):
            m = f"{s.margin:.1%}" if s.margin is not None else "-"
            print(f"{ym:<9}{won(s.total_revenue)}{won(s.total_expense)}{won(s.net_income)}{m:>9}")
    elif args.cmd == "budget":
        s = reports.income_statement(j, *_period(args))
        print(f"[예산 대비 실적] {s.start:%Y-%m}  (잔여 + = 유리)")
        for acct, plan, actual, left in reports.budget_variance(s, st.config().get("budget", {})):
            flag = "  ⚠ 초과" if left < 0 else ""
            print(f"  {acct:<24}예산{won(plan)}  실적{won(actual)}  잔여{won(left)}{flag}")
    elif args.cmd == "review":
        pending = [e for e in j if any(p.account in (UNCATEGORIZED_IN, UNCATEGORIZED_OUT)
                                       for p in e.postings)]
        for e in pending:
            amt = e.postings[0].amount
            print(f"{e.txn_ids[0]}  {e.date}  {amt:>+12,}  {e.postings[0].account:<18} {e.memo}")
        print(f"미분류 {len(pending)}건 — `tag <ID> <계정>` 또는 `rule <키워드> <계정>` 으로 분류")
    elif args.cmd == "summary":
        today = date.today()
        _print_pl(reports.income_statement(j, *reports.month_range(today.strftime("%Y-%m"))))
        b = reports.balance_sheet(j, today)
        print(f"\n순자산 {b.net_worth:,}원 (자산 {b.total_assets:,} / 부채 {b.total_liabilities:,})")
        r = reports.runway_months(j, today)
        print(f"런웨이 {r:.1f}개월 (수입이 끊겨도 현금성 자산으로 버티는 기간)" if r else "런웨이 -")
        n = sum(1 for e in j for p in e.postings if p.account in (UNCATEGORIZED_IN, UNCATEGORIZED_OUT))
        if n:
            print(f"미분류 {n}건 → `review` 로 확인")
    return 0
