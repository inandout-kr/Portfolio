"""Kairos 임베디드 DSL 테스트."""
import pytest

from kairos_dsl import (
    CausalSeries,
    Context,
    LookAheadError,
    Notional,
    Price,
    Shares,
    run_reactive,
)

KRW, USD = "KRW", "USD"


# --- 차원·통화 타입 ----------------------------------------------------------
def test_price_times_shares_is_notional():
    n = Price(10_000, KRW) * Shares(50)
    assert isinstance(n, Notional)
    assert n.value == 500_000 and n.currency == KRW


def test_shares_times_price_commutes():
    assert (Shares(50) * Price(10_000, KRW)).value == 500_000


def test_notional_div_price_is_shares():
    s = Notional(500_000, KRW) / Price(10_000, KRW)
    assert isinstance(s, Shares) and s.value == 50


def test_notional_div_shares_is_price():
    p = Notional(500_000, KRW) / Shares(50)
    assert isinstance(p, Price) and p.value == 10_000 and p.currency == KRW


def test_price_add_same_currency():
    assert (Price(100, KRW) + Price(50, KRW)).value == 150


def test_price_add_cross_currency_raises():
    with pytest.raises(TypeError):
        _ = Price(100, KRW) + Price(1, USD)


def test_notional_add_cross_currency_raises():
    with pytest.raises(TypeError):
        _ = Notional(1, KRW) + Notional(1, USD)


def test_notional_div_price_cross_currency_raises():
    with pytest.raises(TypeError):
        _ = Notional(1, KRW) / Price(1, USD)


def test_price_scalar_scaling():
    assert (Price(100, KRW) * 3).value == 300
    assert (3 * Price(100, KRW)).value == 300


def test_price_plus_scalar_raises():
    with pytest.raises(TypeError):
        _ = Price(100, KRW) + 5


# --- 인과적 시계열 -----------------------------------------------------------
def test_now_and_ago():
    s = CausalSeries([10, 11, 12, 13])
    s.seek(2)
    assert s.now() == 12
    assert s.ago(0) == 12
    assert s.ago(1) == 11


def test_ago_before_history_is_none():
    s = CausalSeries([10, 11, 12])
    s.seek(1)
    assert s.ago(5) is None


def test_ago_negative_is_lookahead_error():
    s = CausalSeries([10, 11, 12])
    s.seek(1)
    with pytest.raises(LookAheadError):
        s.ago(-1)


def test_free_indexing_blocked():
    s = CausalSeries([10, 11, 12])
    with pytest.raises(LookAheadError):
        _ = s[2]


def test_window_respects_now_and_history():
    s = CausalSeries([10, 11, 12, 13, 14])
    s.seek(3)
    assert s.window(2) == [12, 13]
    s.seek(0)
    assert s.window(3) == [10]          # 히스토리 부족하면 있는 만큼


def test_window_requires_positive():
    s = CausalSeries([1, 2, 3])
    with pytest.raises(ValueError):
        s.window(0)


def test_advance_and_seek_bounds():
    s = CausalSeries([1, 2])
    s.seek(1)
    with pytest.raises(IndexError):
        s.advance()
    with pytest.raises(IndexError):
        s.seek(5)


# --- 반응형 블록 -------------------------------------------------------------
def test_run_reactive_collects_signals_causally():
    closes = CausalSeries([100, 102, 101, 105])

    def on_bar(ctx: Context):
        c = ctx["close"]
        prev = c.ago(1)
        if prev is None:
            return None
        return "BUY" if c.now() > prev else "SELL"

    out = run_reactive({"close": closes}, on_bar)
    # t=0 -> prev None (skip), 1: 102>100 BUY, 2: 101<102 SELL, 3: 105>101 BUY
    assert out == [(1, "BUY"), (2, "SELL"), (3, "BUY")]


def test_run_reactive_series_aligned_to_same_t():
    a = CausalSeries([1, 2, 3])
    b = CausalSeries([10, 20, 30])

    seen = []

    def on_bar(ctx: Context):
        seen.append((ctx["a"].now(), ctx["b"].now()))
        return None

    run_reactive({"a": a, "b": b}, on_bar)
    assert seen == [(1, 10), (2, 20), (3, 30)]


def test_run_reactive_length_mismatch_raises():
    with pytest.raises(ValueError):
        run_reactive({"a": CausalSeries([1, 2]), "b": CausalSeries([1])}, lambda c: None)


def test_run_reactive_handler_cannot_see_future():
    closes = CausalSeries([1, 2, 3])

    def on_bar(ctx: Context):
        ctx["close"].ago(-1)   # 미래 접근 시도 -> 터져야 함
        return None

    with pytest.raises(LookAheadError):
        run_reactive({"close": closes}, on_bar)
