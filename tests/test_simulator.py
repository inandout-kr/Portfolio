"""현실화 시뮬레이터 테스트."""
import pytest

from kairos_simulator import (
    Bar,
    Order,
    RealizationSimulator,
    capacity_analysis,
)


def flat_bars(price, value, n, spread_bps=5.0):
    h = price * (1 + spread_bps / 1e4)
    lo = price * (1 - spread_bps / 1e4)
    return [Bar(open=price, high=h, low=lo, close=price, value=value) for _ in range(n)]


# --- 주문 검증 ---------------------------------------------------------------
def test_order_rejects_bad_side():
    with pytest.raises(ValueError):
        Order("hold", "eq", 100)


def test_order_rejects_nonpositive_shares():
    with pytest.raises(ValueError):
        Order("buy", "eq", 0)


# --- 다음 바 체결 / 캐퍼시티 이월 -------------------------------------------
def test_fill_spills_across_bars_by_participation():
    sim = RealizationSimulator(max_participation=0.10)
    # 바당 거래대금 1억, 참여 10% -> 바당 1000만원 = @1만원 기준 1000주.
    order = Order("buy", "eq", shares=2_500)
    rep = sim.execute(order, flat_bars(10_000, value=100_000_000, n=10))
    assert rep.fully_filled
    # 1000 + 1000 + 500 -> 3개 바
    assert len(rep.fills) == 3
    assert rep.fills[0].shares == pytest.approx(1_000, rel=1e-6)


def test_capacity_shortfall_leaves_remaining():
    sim = RealizationSimulator(max_participation=0.10)
    order = Order("buy", "eq", shares=10_000)
    rep = sim.execute(order, flat_bars(10_000, value=100_000_000, n=2))  # 2바 = 2000주만
    assert not rep.fully_filled
    assert rep.remaining_shares == pytest.approx(8_000, rel=1e-6)


def test_buy_fill_price_above_ref_sell_below():
    sim = RealizationSimulator()
    bars = flat_bars(10_000, 1_000_000_000, 1)
    buy = sim.execute(Order("buy", "eq", 100), bars)
    sell = sim.execute(Order("sell", "eq", 100), bars)
    assert buy.avg_fill_price > buy.arrival_price          # 매수는 비싸게
    assert sell.avg_fill_price < sell.arrival_price        # 매도는 싸게
    # 매도는 거래세 때문에 절대 비용(bp)이 더 크다.
    assert abs(sell.slippage_bps) > abs(buy.slippage_bps)


# --- 한국 시장 제약 ----------------------------------------------------------
def test_halted_bars_are_skipped():
    sim = RealizationSimulator()
    bars = flat_bars(10_000, 1_000_000_000, 4)
    bars[0].halted = True
    bars[1].halted = True
    rep = sim.execute(Order("buy", "eq", 100), bars)
    assert rep.fills[0].bar == 2


def test_limit_up_lock_blocks_buy():
    sim = RealizationSimulator()
    locked = [Bar(13_000, 13_000, 13_000, 13_000, value=5_000_000, limit_up=13_000)
              for _ in range(3)]
    rep = sim.execute(Order("buy", "eq", 1_000), locked, prev_close=10_000)
    assert rep.filled_shares == 0
    assert not rep.fully_filled


def test_limit_down_lock_blocks_sell():
    sim = RealizationSimulator()
    locked = [Bar(7_000, 7_000, 7_000, 7_000, value=5_000_000, limit_down=7_000)
              for _ in range(3)]
    rep = sim.execute(Order("sell", "eq", 1_000), locked, prev_close=10_000)
    assert rep.filled_shares == 0


def test_limit_derived_from_prev_close():
    sim = RealizationSimulator(limit_pct=0.30)
    # prev_close 1만원 -> 상한가 1.3만. 1.3만에 잠긴 바면 매수 불가.
    locked = [Bar(13_000, 13_000, 13_000, 13_000, value=5_000_000) for _ in range(2)]
    rep = sim.execute(Order("buy", "eq", 100), locked, prev_close=10_000)
    assert rep.filled_shares == 0


def test_short_rejected_when_not_borrowable():
    sim = RealizationSimulator(borrowable_short=False)
    rep = sim.execute(Order("sell", "eq", 100, is_short=True),
                      flat_bars(10_000, 1_000_000_000, 3))
    assert rep.rejected
    assert rep.reason == "short not borrowable"


def test_short_allowed_when_borrowable():
    sim = RealizationSimulator(borrowable_short=True)
    rep = sim.execute(Order("sell", "eq", 100, is_short=True),
                      flat_bars(10_000, 1_000_000_000, 3))
    assert not rep.rejected
    assert rep.filled_shares == pytest.approx(100, rel=1e-6)


def test_futures_have_no_short_constraint():
    sim = RealizationSimulator(borrowable_short=False)
    rep = sim.execute(Order("sell", "fut", 10, is_short=True),
                      flat_bars(300, 1_000_000_000, 3))
    assert not rep.rejected


# --- 캐퍼시티 분석 -----------------------------------------------------------
def test_capacity_same_day_when_small():
    cap = capacity_analysis(adv_krw=10_000_000_000, target_notional=500_000_000)
    assert cap.feasible_same_day
    assert cap.days_to_fill_ceil == 1


def test_capacity_multiple_days_when_large():
    cap = capacity_analysis(adv_krw=1_000_000_000, target_notional=350_000_000,
                            max_daily_participation=0.10)
    # 일일소화 1억, 목표 3.5억 -> 3.5일 -> 4일
    assert cap.days_to_fill == pytest.approx(3.5)
    assert cap.days_to_fill_ceil == 4
    assert not cap.feasible_same_day


def test_capacity_rejects_bad_adv():
    with pytest.raises(ValueError):
        capacity_analysis(adv_krw=0, target_notional=1_000)
