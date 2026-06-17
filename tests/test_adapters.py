"""실데이터 어댑터 테스트 — 시세(data) / DART 상폐(dart) / LLM(llm)."""
from dataclasses import dataclass
from datetime import date

import pytest

from kairos_data import bar_from_row, bars_from_rows, closes_volumes
from kairos_dart import (
    DartClient,
    DelistingRecord,
    apply_to_universe,
    collect_delistings,
    normalize,
)
from kairos_generator import CATEGORIES
from kairos_llm import DEFAULT_MODEL, make_claude_llm_fn, propose_hypotheses
from kairos_pit import Listing, PITUniverse


# --- 시세 어댑터 -------------------------------------------------------------
def test_bar_from_row_parses_commas_and_synonyms():
    b = bar_from_row({"시가": "10,000", "고가": "10,100", "저가": "9,950",
                      "종가": "10,050", "거래대금": "1,000,000,000"})
    assert b.open == 10000 and b.close == 10050 and b.value == 1_000_000_000


def test_bar_from_row_optional_fields():
    b = bar_from_row({"open": 1, "high": 2, "low": 1, "close": 2, "value": 100,
                      "halted": "true", "limit_up": "3"})
    assert b.halted is True and b.limit_up == 3.0 and b.limit_down is None


def test_bar_from_row_missing_value_raises():
    with pytest.raises(KeyError):
        bar_from_row({"open": 1, "high": 2, "low": 1, "close": 2})


def test_bars_from_rows_count():
    rows = [{"open": 1, "high": 1, "low": 1, "close": 1, "value": 1} for _ in range(3)]
    assert len(bars_from_rows(rows)) == 3


def test_closes_volumes_falls_back_to_value():
    rows = [
        {"close": "100", "value": "5000", "volume": "10"},
        {"close": "101", "value": "6000"},   # volume 없음 → value 대체
    ]
    closes, volumes = closes_volumes(rows)
    assert closes == [100.0, 101.0]
    assert volumes == [10.0, 6000.0]


# --- DART 상폐 수집 ----------------------------------------------------------
def test_normalize_parses_dates_and_pads_ticker():
    recs = normalize([
        {"stock_code": "660", "상장폐지일": "2026.05.20"},
        {"ticker": "123456", "delisting_date": "20260601"},
    ], recorded_on=date(2026, 6, 17))
    assert recs[0].ticker == "000660"            # zfill(6)
    assert recs[0].delisted_on == date(2026, 5, 20)
    assert recs[1].delisted_on == date(2026, 6, 1)
    assert all(r.recorded_on == date(2026, 6, 17) for r in recs)


def test_normalize_rejects_bad_date():
    with pytest.raises(ValueError):
        normalize([{"stock_code": "1", "delisted_on": "not-a-date"}])


def test_normalize_missing_ticker_raises():
    with pytest.raises(KeyError):
        normalize([{"상장폐지일": "2026-01-01"}])


def test_collect_uses_injected_fetch_fn():
    def fetch():
        return [{"stock_code": "123456", "delisted_on": "2026-05-20"}]
    recs = collect_delistings(fetch, recorded_on=date(2026, 6, 1))
    assert len(recs) == 1 and recs[0].ticker == "123456"


def test_apply_to_universe_removes_delisted_and_skips_unknown():
    uni = PITUniverse(coverage_start=date(2026, 1, 1))
    uni.add_listing(Listing("123456", listed_on=date(2019, 1, 1)))
    recs = [
        DelistingRecord("123456", date(2026, 5, 20), date(2026, 6, 1)),
        DelistingRecord("999999", date(2026, 6, 1), date(2026, 6, 1)),  # 미추적
    ]
    applied = apply_to_universe(uni, recs)
    assert applied == 1
    assert "123456" not in uni.as_of(date(2026, 6, 30))


def test_apply_to_universe_strict_raises_on_unknown():
    uni = PITUniverse()
    with pytest.raises(KeyError):
        apply_to_universe(uni, [DelistingRecord("000001", date(2026, 1, 1))],
                          skip_unknown=False)


def test_dart_client_requires_key(monkeypatch):
    monkeypatch.delenv("DART_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        DartClient()


def test_dart_client_takes_explicit_key():
    c = DartClient(api_key="dummy")
    assert c.api_key == "dummy"


# --- LLM 어댑터 (가짜 client 주입) -------------------------------------------
@dataclass
class _Block:
    type: str
    text: str


@dataclass
class _Msg:
    content: list


class _FakeClient:
    """Anthropic client 의 messages.create 만 흉내."""
    def __init__(self, text):
        self._text = text
        self.calls = []

        class _M:
            def create(inner, **kwargs):
                self.calls.append(kwargs)
                return _Msg(content=[_Block("text", self._text)])
        self.messages = _M()


def test_make_claude_llm_fn_uses_model_and_system():
    fake = _FakeClient("behavioral|모멘텀")
    fn = make_claude_llm_fn(client=fake)
    out = fn("제안해줘")
    assert out == "behavioral|모멘텀"
    assert fake.calls[0]["model"] == DEFAULT_MODEL
    assert "category" in fake.calls[0]["system"]
    assert fake.calls[0]["messages"] == [{"role": "user", "content": "제안해줘"}]


def test_make_claude_llm_fn_extracts_only_text_blocks():
    fake = _FakeClient("behavioral|x")
    # thinking 등 비-text 블록은 무시되어야 함
    fake.messages.create = lambda **k: _Msg(content=[
        _Block("thinking", "..."), _Block("text", "behavioral|x")])
    fn = make_claude_llm_fn(client=fake)
    assert fn("p") == "behavioral|x"


def test_propose_hypotheses_builds_valid_candidates():
    fake = _FakeClient("behavioral|모멘텀 드리프트\nsupply_demand|거래량 급증")
    cands = propose_hypotheses("제안", llm_fn=make_claude_llm_fn(client=fake))
    assert len(cands) == 2
    assert all(c.thesis.category in CATEGORIES for c in cands)
