"""승격 파이프라인 테스트."""
import numpy as np
import pytest

from kairos_promotion import (
    BACKTEST,
    FORWARD,
    LIVE,
    PAPER,
    RETIRED,
    PromotionPipeline,
    PromotionPolicy,
)


def good(n, sr=0.12, seed=0):
    """표본 per-period 샤프가 정확히 sr 인 수익률 (결정적)."""
    x = np.random.default_rng(seed).normal(0.0, 0.01, n)
    x = x - x.mean()
    sd = x.std(ddof=1)
    return x + sr * sd


# --- 진입 -------------------------------------------------------------------
def test_admit_passed_goes_to_paper():
    pipe = PromotionPipeline()
    rec = pipe.admit("a", backtest_passed=True, backtest_sharpe=0.18)
    assert rec.stage == PAPER


def test_admit_failed_goes_to_retired():
    pipe = PromotionPipeline()
    rec = pipe.admit("a", backtest_passed=False, backtest_sharpe=0.0)
    assert rec.stage == RETIRED


# --- 페이퍼 -> 포워드 --------------------------------------------------------
def test_paper_to_forward_on_good_paper():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.18)
    pipe.record_paper("a", good(60, seed=1))
    d = pipe.try_promote("a")
    assert d.promoted and d.stage == FORWARD


def test_paper_insufficient_samples_blocks():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.18)
    pipe.record_paper("a", good(10, seed=1))
    d = pipe.try_promote("a")
    assert not d.promoted
    assert any("표본 부족" in r for r in d.reasons)


def test_paper_negative_perf_blocks():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.18)
    pipe.record_paper("a", good(60, sr=-0.12, seed=2))
    d = pipe.try_promote("a")
    assert not d.promoted
    assert any("성과 미달" in r for r in d.reasons)


# --- 휴먼 게이트 (제거 불가) -------------------------------------------------
def test_live_blocked_without_human_approval():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.18)
    pipe.record_paper("a", good(60, seed=1))
    pipe.try_promote("a")                       # -> FORWARD
    pipe.record_forward("a", good(60, sr=0.13, seed=3))
    d = pipe.try_promote("a")                   # 휴먼 미승인
    assert not d.promoted
    assert d.stage == FORWARD
    assert any("휴먼 게이트" in r for r in d.reasons)


def test_live_allowed_after_human_approval():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.18)
    pipe.record_paper("a", good(60, seed=1))
    pipe.try_promote("a")
    pipe.record_forward("a", good(60, sr=0.13, seed=3))
    pipe.human_approve("a", "kiunghan")
    d = pipe.try_promote("a")
    assert d.promoted and d.stage == LIVE


# --- 알파 감쇠 (포워드 우선) -------------------------------------------------
def test_alpha_decay_blocks_live():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.30)                 # 백테스트 샤프 높음
    pipe.record_paper("a", good(60, seed=1))
    pipe.try_promote("a")
    pipe.record_forward("a", good(200, sr=0.10, seed=4))  # 포워드 크게 죽음
    pipe.human_approve("a", "kiunghan")
    d = pipe.try_promote("a")
    assert not d.promoted
    assert any("감쇠" in r for r in d.reasons)


# --- 라이브 피드백 -----------------------------------------------------------
def test_live_divergence_alerts_on_big_gap():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.20)
    pipe.record_live("a", good(60, sr=-0.10, seed=5))    # 라이브 음수
    out = pipe.live_divergence("a")
    assert out["alert"] is True
    assert "divergence" in out


def test_live_divergence_no_alert_when_aligned():
    pipe = PromotionPipeline(PromotionPolicy(live_divergence_tol=2.0))
    pipe.admit("a", True, 0.18)
    pipe.record_live("a", good(80, sr=0.13, seed=6))
    out = pipe.live_divergence("a")
    assert out["alert"] is False


def test_live_divergence_insufficient_samples():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.18)
    pipe.record_live("a", good(5, seed=7))
    assert pipe.live_divergence("a")["alert"] is False


# --- 단계 가드 ---------------------------------------------------------------
def test_cannot_promote_from_backtest_or_retired():
    pipe = PromotionPipeline()
    rec = pipe.admit("a", False, 0.0)           # RETIRED
    assert not pipe.try_promote("a").promoted
    assert rec.stage == RETIRED


def test_full_lifecycle_history_recorded():
    pipe = PromotionPipeline()
    pipe.admit("a", True, 0.18)
    pipe.record_paper("a", good(60, seed=1))
    pipe.try_promote("a")
    pipe.record_forward("a", good(60, sr=0.13, seed=3))
    pipe.human_approve("a", "kiunghan")
    pipe.try_promote("a")
    hist = pipe.get("a").history
    assert any("PAPER" in h for h in hist)
    assert any("LIVE" in h for h in hist)
