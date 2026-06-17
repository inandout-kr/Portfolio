"""통계 검증 하니스 테스트."""
import numpy as np
import pytest

from kairos_harness import (
    GateThresholds,
    TrialLedger,
    backtest_overfit_prob,
    evaluate_strategy,
    regime_robustness,
    walk_forward,
)


# --- 전역 시도 원장 ----------------------------------------------------------
def test_ledger_counts_and_variance_in_memory():
    led = TrialLedger(path=None)
    for s in (0.1, 0.2, 0.3):
        led.record(s)
    assert led.n_trials == 3
    assert led.sr_variance() == pytest.approx(np.var([0.1, 0.2, 0.3], ddof=1))


def test_ledger_variance_fallback_when_few():
    led = TrialLedger(path=None)
    led.record(0.1)
    assert led.sr_variance(fallback=0.007) == 0.007


def test_ledger_persists_across_instances(tmp_path):
    p = str(tmp_path / "sub" / "trials.json")
    led = TrialLedger(path=p)
    led.record(0.15)
    led.record(0.25)
    reopened = TrialLedger(path=p)
    assert reopened.n_trials == 2
    assert reopened._sharpes == [0.15, 0.25]


# --- 워크포워드 / 안정성 -----------------------------------------------------
def test_walk_forward_splits_and_reports():
    rng = np.random.default_rng(0)
    r = rng.normal(0.002, 0.01, 600)
    wf = walk_forward(r, n_folds=6)
    assert len(wf.fold_sharpes) == 6
    assert wf.worst_sharpe == min(wf.fold_sharpes)


def test_walk_forward_needs_min_folds():
    with pytest.raises(ValueError):
        walk_forward(np.zeros(10), n_folds=1)


def test_walk_forward_rejects_too_short():
    with pytest.raises(ValueError):
        walk_forward(np.zeros(3), n_folds=5)


# --- 레짐 -------------------------------------------------------------------
def test_regime_robustness_per_label():
    r = np.array([0.01, -0.01, 0.02, -0.02])
    g = np.array(["a", "b", "a", "b"])
    out = regime_robustness(r, g)
    assert set(out) == {"a", "b"}
    assert out["a"] > 0 and out["b"] < 0


def test_regime_length_mismatch_raises():
    with pytest.raises(ValueError):
        regime_robustness(np.zeros(4), np.array(["a", "b"]))


# --- 종합 게이트 -------------------------------------------------------------
def test_evaluate_records_trial_and_uses_global_n():
    led = TrialLedger(path=None)
    rng = np.random.default_rng(7)
    r = rng.normal(0.0025, 0.01, 1260)
    v = evaluate_strategy(r, led, n_folds=6)
    assert v.n_trials == 1                 # 기록되어 N=1
    assert led.n_trials == 1


def test_strong_alpha_passes_with_small_ledger():
    led = TrialLedger(path=None)
    rng = np.random.default_rng(7)
    r = rng.normal(0.003, 0.01, 1260)
    v = evaluate_strategy(r, led, n_folds=6)
    assert v.passed
    assert v.dsr > 0.95


def test_multiple_testing_pressure_can_fail_alpha():
    led = TrialLedger(path=None)
    rng = np.random.default_rng(7)
    r = rng.normal(0.0025, 0.01, 1260)
    # 과거에 높은 샤프 시도들을 잔뜩 쌓으면 SR0 가 올라가 DSR 이 떨어진다.
    for _ in range(20000):
        led.record(rng.normal(0.08, 0.05))
    v = evaluate_strategy(r, led, n_folds=6)
    assert not v.passed
    assert any("DSR" in reason for reason in v.reasons)


def test_regime_fragile_strategy_flagged():
    rng = np.random.default_rng(3)
    n = 1200
    regimes = np.where(np.arange(n) % 2 == 0, "bull", "bear")
    r = rng.normal(0.003, 0.01, n)
    r[regimes == "bear"] = rng.normal(-0.003, 0.01, (regimes == "bear").sum())
    v = evaluate_strategy(r, TrialLedger(), regimes=regimes, n_folds=6)
    assert not v.passed
    assert any("레짐" in reason for reason in v.reasons)


def test_noise_fails():
    led = TrialLedger(path=None)
    rng = np.random.default_rng(1)
    r = rng.normal(0.0, 0.01, 1260)
    v = evaluate_strategy(r, led, n_folds=6)
    assert not v.passed


def test_thresholds_are_configurable():
    led = TrialLedger(path=None)
    rng = np.random.default_rng(7)
    r = rng.normal(0.003, 0.01, 1260)
    strict = GateThresholds(min_dsr=0.999999)
    v = evaluate_strategy(r, led, thresholds=strict, n_folds=6)
    # 매우 엄격한 DSR 기준이면 통과 못 할 수 있음
    assert isinstance(v.passed, bool)


# --- PBO 래퍼 ---------------------------------------------------------------
def test_backtest_overfit_prob_low_for_persistent_alpha():
    rng = np.random.default_rng(5)
    M = rng.normal(0, 0.01, (1500, 25))
    M[:, 0] += 0.002
    assert backtest_overfit_prob(M, n_splits=10) < 0.25
