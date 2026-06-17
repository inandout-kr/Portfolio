"""kairos_verifier 코어 가드/비용모델 테스트."""
import numpy as np

from kairos_verifier import (
    KoreanCostModel,
    deflated_sharpe_ratio,
    expected_max_sharpe,
    pbo_cscv,
    probabilistic_sharpe_ratio,
    sharpe,
)


# --- 비용 모델 ---------------------------------------------------------------
def test_eq_sell_includes_transaction_tax():
    cm = KoreanCostModel()
    buy = cm.one_way_bps("buy", "eq")
    sell = cm.one_way_bps("sell", "eq")
    # 매도엔 거래세 20bp 가 더 붙어야 한다.
    assert sell - buy == cm.eq_sell_tax_bps == 20.0


def test_fut_has_no_sell_tax():
    cm = KoreanCostModel()
    assert cm.one_way_bps("buy", "fut") == cm.one_way_bps("sell", "fut")


def test_round_trip_eq_is_about_33bp_wall():
    cm = KoreanCostModel()
    rt = cm.round_trip_bps("eq", participation=0.05, sigma_bps=8.0)
    # CLAUDE.md §7: 현물 왕복 ≈ 33bp 벽
    assert 32.0 < rt < 34.0


def test_slippage_increases_with_participation():
    cm = KoreanCostModel()
    small = cm.slippage_bps(0.01, 10.0)
    large = cm.slippage_bps(0.25, 10.0)
    assert large > small


def test_unknown_instrument_raises():
    cm = KoreanCostModel()
    try:
        cm.one_way_bps("buy", "bond")
    except ValueError:
        return
    raise AssertionError("expected ValueError")


# --- 과최적화 가드 -----------------------------------------------------------
def test_sharpe_zero_on_constant_returns():
    assert sharpe(np.ones(50)) == 0.0


def test_psr_high_for_strong_alpha_low_for_noise():
    rng = np.random.default_rng(0)
    strong = rng.normal(0.002, 0.01, 1500)
    noise = rng.normal(0.0, 0.01, 1500)
    assert probabilistic_sharpe_ratio(strong) > 0.99
    assert probabilistic_sharpe_ratio(noise) < 0.9


def test_expected_max_sharpe_grows_with_trials():
    assert expected_max_sharpe(100_000, 0.004) > expected_max_sharpe(100, 0.004)


def test_dsr_tightens_as_trials_grow():
    rng = np.random.default_rng(7)
    r = rng.normal(0.0025, 0.01, 1260)
    lo = deflated_sharpe_ratio(r, n_trials=100, sr_variance=0.004)
    hi = deflated_sharpe_ratio(r, n_trials=100_000, sr_variance=0.004)
    # 시도 횟수가 늘수록 통과 확률은 떨어진다 (deflation).
    assert hi < lo


def test_pbo_low_for_persistent_alpha():
    rng = np.random.default_rng(3)
    M = rng.normal(0, 0.01, (2000, 30))
    M[:, 0] += 0.002  # 한 전략에만 지속 알파
    assert pbo_cscv(M, n_splits=10) < 0.2


def test_pbo_requires_even_splits():
    rng = np.random.default_rng(1)
    M = rng.normal(0, 0.01, (200, 5))
    try:
        pbo_cscv(M, n_splits=7)
    except ValueError:
        return
    raise AssertionError("expected ValueError on odd n_splits")
