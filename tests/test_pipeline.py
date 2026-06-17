"""통합 발굴 루프 테스트 — 8개 모듈이 한 줄기로 동작하는지."""
import random
from datetime import date

import numpy as np

from kairos_generator import Candidate, GeneticGenerator, Node, TERMINALS, Thesis
from kairos_harness import TrialLedger
from kairos_pipeline import (
    BLOCKED_BIASED_DATA,
    PROMOTED_PAPER,
    REJECTED_LIQUIDITY,
    REJECTED_OVERFIT,
    DiscoveryPipeline,
    backtest_candidate,
)
from kairos_promotion import PAPER, PromotionPipeline
from kairos_pit import PITUniverse
from kairos_simulator import KoreanCostModel, RealizationSimulator
from kairos_supervisor import LIQUIDITY, OVERFIT, Supervisor


def term(name):
    return Candidate(Node("term", terminal=next(t for t in TERMINALS if t.name == name)),
                     Thesis("behavioral", "x"))


def trending(n=800, mu=0.003, sd=0.005, seed=3):
    return (100 * np.exp(np.cumsum(np.random.default_rng(seed).normal(mu, sd, n)))).tolist()


def make_pipe(ledger=None):
    return DiscoveryPipeline(
        generator=GeneticGenerator(rng=random.Random(1), max_depth=2),
        simulator=RealizationSimulator(),
        ledger=ledger or TrialLedger(path=None),
        promotion=PromotionPipeline(),
        supervisor=Supervisor(),
    )


# --- 현실화 백테스트 ---------------------------------------------------------
def test_backtest_returns_have_n_minus_one_length():
    closes = trending(50)
    rets, turnover = backtest_candidate(term("mom5"), closes, None, KoreanCostModel())
    assert len(rets) == len(closes) - 1
    assert 0.0 <= turnover <= 1.0


def test_backtest_costs_reduce_returns():
    closes = trending(200)
    free = KoreanCostModel(eq_commission_bps=0, eq_sell_tax_bps=0, half_spread_bps=0, impact_k=0)
    r_free, _ = backtest_candidate(term("mom5"), closes, None, free)
    r_cost, _ = backtest_candidate(term("mom5"), closes, None, KoreanCostModel())
    assert r_cost.sum() < r_free.sum()      # 비용이 수익을 깎는다


def test_backtest_is_causal_no_lookahead():
    # 미래를 바꿔도 과거 결정/수익은 불변이어야 한다.
    closes = trending(100)
    r1, _ = backtest_candidate(term("mom5"), closes, None, KoreanCostModel())
    tampered = closes[:60] + [c * 5 for c in closes[60:]]
    r2, _ = backtest_candidate(term("mom5"), tampered, None, KoreanCostModel())
    # t<59 의 수익(=t->t+1, t+1<=59)은 동일
    assert np.allclose(r1[:58], r2[:58])


# --- 성공 경로 ---------------------------------------------------------------
def test_strong_momentum_promotes_to_paper():
    pipe = make_pipe()
    out = pipe.evaluate_one(term("mom5"), trending(800), None, None,
                            adv_krw=5e9, target_notional=1e9, sid="s")
    assert out.status == PROMOTED_PAPER
    assert out.backtest_sharpe > 0
    assert pipe.promotion.get("s").stage == PAPER


# --- 실패 경로 (overfit / 노이즈) -------------------------------------------
def test_noise_is_rejected_and_logged():
    pipe = make_pipe()
    noise = (100 * np.exp(np.cumsum(
        np.random.default_rng(9).normal(0.0, 0.01, 600)))).tolist()
    out = pipe.evaluate_one(term("rev5"), noise, None, None,
                            adv_krw=5e9, target_notional=1e9, sid="n")
    assert out.status == REJECTED_OVERFIT
    assert pipe.supervisor.log.count(OVERFIT) == 1


# --- 실패 경로 (liquidity / 캐퍼시티) ---------------------------------------
def test_too_big_order_rejected_as_liquidity():
    pipe = make_pipe()
    out = pipe.evaluate_one(term("mom5"), trending(300), None, None,
                            adv_krw=1e8, target_notional=1e11,  # ADV 대비 과대
                            sid="big")
    assert out.status == REJECTED_LIQUIDITY
    assert pipe.supervisor.log.count(LIQUIDITY) == 1


# --- PIT 생존편향 차단 -------------------------------------------------------
def test_biased_window_blocks_discovery():
    pipe = make_pipe()
    uni = PITUniverse(coverage_start=date(2020, 1, 1))
    outs = pipe.run(trending(300), n_candidates=5, universe=uni, asof=date(2018, 1, 1))
    assert len(outs) == 1
    assert outs[0].status == BLOCKED_BIASED_DATA


def test_unbiased_window_allows_discovery():
    pipe = make_pipe()
    uni = PITUniverse(coverage_start=date(2020, 1, 1))
    outs = pipe.run(trending(300), n_candidates=3, universe=uni, asof=date(2021, 1, 1))
    assert len(outs) == 3
    assert all(o.status != BLOCKED_BIASED_DATA for o in outs)


# --- 원장 누적 (다중검정) ----------------------------------------------------
def test_run_accumulates_trials_in_ledger():
    ledger = TrialLedger(path=None)
    pipe = make_pipe(ledger=ledger)
    pipe.run(trending(300), n_candidates=4)
    assert ledger.n_trials == 4


def test_run_returns_outcome_per_candidate():
    pipe = make_pipe()
    outs = pipe.run(trending(300), n_candidates=7)
    assert len(outs) == 7
    assert all(o.category for o in outs)
