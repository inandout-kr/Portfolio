"""바깥쪽 supervisor 루프 테스트."""
import pytest

from kairos_supervisor import (
    ALPHA_DECAY,
    COST_MODEL,
    DATA,
    DISCARD,
    FailureEvent,
    FailureLog,
    LIQUIDITY,
    LIVE_DIVERGENCE,
    OVERFIT,
    RECALIBRATE,
    REGIME,
    REPARAMETRIZE,
    RESUME,
    RETIRE,
    STRENGTHEN_GUARD,
    Supervisor,
    SupervisorPolicy,
)


# --- 이벤트 검증 -------------------------------------------------------------
def test_failure_event_rejects_unknown_type():
    with pytest.raises(ValueError):
        FailureEvent("METEOR")


# --- 처치 정책 ---------------------------------------------------------------
def test_data_failure_cleans_and_resumes():
    t = Supervisor().treat(FailureEvent(DATA, detail={"missing": 3}))
    assert t.action == RESUME
    assert t.resumes_discovery


def test_liquidity_first_reparametrizes_then_discards():
    sup = Supervisor(policy=SupervisorPolicy(repeat_threshold=3))
    actions = [sup.treat(FailureEvent(LIQUIDITY)).action for _ in range(4)]
    assert actions[:2] == [REPARAMETRIZE, REPARAMETRIZE]
    assert actions[2] == DISCARD            # 3회차에서 임계 도달
    assert actions[3] == DISCARD


def test_overfit_discards_then_strengthens_guard():
    sup = Supervisor(policy=SupervisorPolicy(repeat_threshold=3))
    actions = [sup.treat(FailureEvent(OVERFIT)).action for _ in range(3)]
    assert actions == [DISCARD, DISCARD, STRENGTHEN_GUARD]


# --- 라이브 괴리 진단 + 처치 -------------------------------------------------
def test_divergence_regime_recalibrates():
    t = Supervisor().treat(FailureEvent(LIVE_DIVERGENCE, detail={"subtype": REGIME}))
    assert t.action == RECALIBRATE


def test_divergence_cost_model_recalibrates():
    t = Supervisor().treat(FailureEvent(LIVE_DIVERGENCE, detail={"subtype": COST_MODEL}))
    assert t.action == RECALIBRATE


def test_divergence_alpha_decay_retires():
    t = Supervisor().treat(FailureEvent(LIVE_DIVERGENCE, detail={"subtype": ALPHA_DECAY}))
    assert t.action == RETIRE


def test_divergence_unknown_discards():
    t = Supervisor().treat(FailureEvent(LIVE_DIVERGENCE, detail={}))
    assert t.action == DISCARD


def test_diagnose_divergence_heuristics():
    assert Supervisor.diagnose_divergence({"regime_shift": True}) == REGIME
    assert Supervisor.diagnose_divergence(
        {"realized_slippage_bps": 40, "modeled_slippage_bps": 20}) == COST_MODEL
    assert Supervisor.diagnose_divergence({"forward_below_backtest": True}) == ALPHA_DECAY
    assert Supervisor.diagnose_divergence({}) == "unknown"


# --- 영구 실패 로그 ----------------------------------------------------------
def test_failure_log_counts_modes():
    log = FailureLog()
    sup = Supervisor(log=log)
    sup.treat(FailureEvent(DATA))
    sup.treat(FailureEvent(DATA))
    sup.treat(FailureEvent(OVERFIT))
    assert log.count(DATA) == 2
    assert log.mode_counts() == {DATA: 2, OVERFIT: 1}


def test_failure_log_persists(tmp_path):
    p = str(tmp_path / "k" / "failures.json")
    sup = Supervisor(log=FailureLog(path=p))
    sup.treat(FailureEvent(LIQUIDITY, sid="z"))
    sup.treat(FailureEvent(LIQUIDITY, sid="z"))
    reopened = FailureLog(path=p)
    assert reopened.count(LIQUIDITY) == 2


def test_persistent_log_escalates_across_instances(tmp_path):
    p = str(tmp_path / "failures.json")
    pol = SupervisorPolicy(repeat_threshold=3)
    # 두 번은 한 세션, 세 번째는 '새 세션'(새 Supervisor, 같은 로그파일)
    s1 = Supervisor(log=FailureLog(path=p), policy=pol)
    assert s1.treat(FailureEvent(OVERFIT)).action == DISCARD
    assert s1.treat(FailureEvent(OVERFIT)).action == DISCARD
    s2 = Supervisor(log=FailureLog(path=p), policy=pol)
    # 영구 로그 덕분에 누적 3회 -> 격상
    assert s2.treat(FailureEvent(OVERFIT)).action == STRENGTHEN_GUARD


def test_all_treatments_resume_discovery():
    sup = Supervisor()
    for ev in [FailureEvent(DATA), FailureEvent(LIQUIDITY),
               FailureEvent(OVERFIT),
               FailureEvent(LIVE_DIVERGENCE, detail={"subtype": ALPHA_DECAY})]:
        assert sup.treat(ev).resumes_discovery
