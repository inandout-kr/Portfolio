"""mybiz 개인 장부 테스트 — 가져오기 / 분류(이체 상계) / 보고서 / 저장소."""
from datetime import date

import pytest

from mybiz import reports
from mybiz.classify import Rule, classify, pair_transfers
from mybiz.cli import main
from mybiz.importers import parse_amount, parse_date, read_csv_rows, rows_to_txns
from mybiz.model import JournalEntry, Posting, RawTxn, account_type, AccountType
from mybiz.store import Store

BANK = "자산:통장:국민"
CARD = "부채:카드:신한"
D = date


def T(d, amt, desc, src=BANK, seq=0):
    return RawTxn(d, amt, desc, src, seq)


# --- model -----------------------------------------------------------
def test_account_type_and_bad_prefix():
    assert account_type("비용:변동:식비") is AccountType.EXPENSE
    with pytest.raises(ValueError):
        account_type("식비")


def test_unbalanced_entry_rejected():
    with pytest.raises(ValueError):
        JournalEntry(D(2026, 9, 1), "x", [Posting(BANK, 100), Posting("비용:x", -99)])


def test_raw_txn_source_must_be_own_and_id_deterministic():
    with pytest.raises(ValueError):
        RawTxn(D(2026, 9, 1), -1, "x", "비용:식비")
    assert T(D(2026, 9, 1), -100, "a").id == T(D(2026, 9, 1), -100, "a").id
    assert T(D(2026, 9, 1), -100, "a").id != T(D(2026, 9, 1), -100, "a", seq=1).id


# --- importers -------------------------------------------------------
def test_parse_helpers():
    assert parse_date("2026.09.01 13:22") == D(2026, 9, 1)
    assert parse_date("20260901") == D(2026, 9, 1)
    assert parse_date("2026년 9월 1일") == D(2026, 9, 1)
    assert parse_amount("1,234원") == 1234
    assert parse_amount("(5,000)") == -5000
    assert parse_amount("") == 0


def test_bank_csv_with_preamble_in_out_columns():
    text = ("계좌번호,123-45\n조회기간,2026.09.01~2026.09.30\n"
            "거래일시,적요,출금액,입금액,잔액\n"
            "2026.09.01 09:00,급여,,\"3,000,000\",\"3,000,000\"\n"
            "2026.09.02 12:00,스타벅스,\"5,000\",,\"2,995,000\"\n"
            "합계,,5000,3000000,\n")
    txns = rows_to_txns(read_csv_rows(text), BANK)
    assert [(t.amount, t.description) for t in txns] == [(3_000_000, "급여"), (-5000, "스타벅스")]


def test_card_single_amount_is_charge_and_negative_is_refund():
    rows = [{"이용일": "2026-09-03", "가맹점명": "쿠팡", "이용금액": "20,000"},
            {"이용일": "2026-09-04", "가맹점명": "쿠팡 취소", "이용금액": "-20,000"}]
    assert [t.amount for t in rows_to_txns(rows, CARD)] == [-20000, 20000]


def test_banksalad_style_type_column():
    rows = [{"날짜": "2026-09-01", "타입": "지출", "내용": "택시", "금액": "12000"},
            {"날짜": "2026-09-01", "타입": "수입", "내용": "이자", "금액": "300"}]
    assert [t.amount for t in rows_to_txns(rows, BANK)] == [-12000, 300]


def test_identical_rows_get_distinct_seq():
    rows = [{"날짜": "2026-09-01", "내용": "편의점", "금액": "-1500"}] * 2
    txns = rows_to_txns(rows, BANK)
    assert len({t.id for t in txns}) == 2


# --- classify --------------------------------------------------------
def test_internal_transfer_is_paired_not_income_or_expense():
    txns = [T(D(2026, 9, 10), -500_000, "신한카드 결제"),
            T(D(2026, 9, 11), 500_000, "결제 입금", CARD)]
    entries = classify(txns, rules=[])
    assert len(entries) == 1
    accts = {p.account for p in entries[0].postings}
    assert accts == {BANK, CARD}


def test_transfer_window_and_same_source_excluded():
    txns = [T(D(2026, 9, 1), -100, "a"), T(D(2026, 9, 1), 100, "b")]  # 같은 계정
    assert pair_transfers(txns) == []
    far = [T(D(2026, 9, 1), -100, "a"), T(D(2026, 9, 10), 100, "b", CARD)]
    assert pair_transfers(far, window_days=2) == []


def test_rule_to_liability_is_card_payment_not_expense():
    txns = [T(D(2026, 9, 10), -500_000, "신한카드 대금")]
    e = classify(txns, [Rule("신한카드", CARD, "out")])[0]
    stmt = reports.income_statement([e], D(2026, 9, 1), D(2026, 9, 30))
    assert stmt.total_expense == 0


def test_rule_order_direction_and_uncategorized():
    rules = [Rule("쿠팡이츠", "비용:식비"), Rule("쿠팡", "비용:쇼핑", "out")]
    txns = [T(D(2026, 9, 1), -10, "쿠팡이츠"), T(D(2026, 9, 1), -20, "쿠팡"),
            T(D(2026, 9, 1), 30, "쿠팡 환불"), T(D(2026, 9, 1), -40, "???")]
    got = {e.memo: e.postings[1].account for e in classify(txns, rules)}
    assert got == {"쿠팡이츠": "비용:식비", "쿠팡": "비용:쇼핑",
                   "쿠팡 환불": "수익:미분류", "???": "비용:미분류"}


def test_override_beats_pairing_and_rules():
    a, b = T(D(2026, 9, 1), -100, "x"), T(D(2026, 9, 1), 100, "y", CARD)
    entries = classify([a, b], [], overrides={a.id: "비용:선물"})
    assert any(p.account == "비용:선물" for e in entries for p in e.postings)
    assert len(entries) == 2  # 짝지어지지 않음


# --- reports ---------------------------------------------------------
@pytest.fixture
def journal():
    txns = [
        T(D(2026, 8, 25), 3_000_000, "급여"),
        T(D(2026, 8, 26), -800_000, "월세"),
        T(D(2026, 9, 1), -30_000, "배달의민족", CARD),
        T(D(2026, 9, 2), -70_000, "쿠팡", CARD),
        T(D(2026, 9, 10), -100_000, "신한카드 결제"),
        T(D(2026, 9, 25), 3_000_000, "급여"),
        T(D(2026, 9, 26), -800_000, "월세"),
    ]
    rules = [Rule("급여", "수익:근로소득", "in"), Rule("월세", "비용:고정:주거"),
             Rule("배달", "비용:변동:식비"), Rule("쿠팡", "비용:변동:쇼핑"),
             Rule("신한카드", CARD, "out")]
    opening = reports.opening_entry({BANK: 1_000_000, CARD: -50_000}, D(2026, 8, 1))
    return [opening] + classify(txns, rules)


def test_income_statement(journal):
    s = reports.income_statement(journal, D(2026, 9, 1), D(2026, 9, 30))
    assert s.total_revenue == 3_000_000
    assert s.expense == {"비용:고정:주거": 800_000, "비용:변동:쇼핑": 70_000, "비용:변동:식비": 30_000}
    assert s.net_income == 2_100_000
    assert s.margin == pytest.approx(0.7)


def test_balance_sheet_identity(journal):
    b = reports.balance_sheet(journal, D(2026, 9, 30))
    assert b.assets == {BANK: 1_000_000 + 3_000_000 * 2 - 800_000 * 2 - 100_000}
    assert b.liabilities == {CARD: 50_000 + 100_000 - 100_000}
    assert b.opening_equity == 950_000
    assert b.net_worth == b.opening_equity + b.retained_earnings


def test_monthly_budget_runway(journal):
    months = dict(reports.monthly(journal))
    assert list(months) == ["2026-08", "2026-09"]
    assert months["2026-08"].net_income == 2_200_000
    rows = reports.budget_variance(months["2026-09"], {"비용:변동:식비": 20_000, "수익:근로소득": 2_500_000})
    assert rows == [("비용:변동:식비", 20_000, 30_000, -10_000),
                    ("수익:근로소득", 2_500_000, 3_000_000, 500_000)]
    r = reports.runway_months(journal, D(2026, 9, 30))
    assert r == pytest.approx(5_300_000 / ((800_000 + 900_000) / 2))


def test_month_range_december():
    assert reports.month_range("2026-12") == (D(2026, 12, 1), D(2026, 12, 31))


# --- store / cli -----------------------------------------------------
def test_store_dedup_override_and_rule(tmp_path):
    st = Store(tmp_path)
    txns = [T(D(2026, 9, 1), -9_000, "올리브영")]
    assert st.add_txns(txns) == 1
    assert st.add_txns(txns) == 0
    assert any(p.account == "비용:미분류" for e in st.journal() for p in e.postings)
    st.add_rule("올리브영", "비용:변동:쇼핑", "out")
    assert any(p.account == "비용:변동:쇼핑" for e in st.journal() for p in e.postings)
    st.set_override(txns[0].id, "비용:선물")
    assert any(p.account == "비용:선물" for e in st.journal() for p in e.postings)
    with pytest.raises(KeyError):
        st.set_override("nope", "비용:x")


def test_cli_end_to_end(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MYBIZ_HOME", str(tmp_path / "data"))
    csv_path = tmp_path / "bank.csv"
    csv_path.write_bytes("거래일자,적요,출금액,입금액\n2026-09-25,급여,,3000000\n"
                         "2026-09-26,월세,800000,\n".encode("cp949"))
    assert main(["import", str(csv_path), "--source", BANK]) == 0
    assert "신규 2건" in capsys.readouterr().out
    main(["pl", "--month", "2026-09"])
    out = capsys.readouterr().out
    assert "수익:근로소득" in out and "2,200,000원" in out
    main(["bs", "--date", "2026-09-30"])
    assert "순자산" in capsys.readouterr().out
