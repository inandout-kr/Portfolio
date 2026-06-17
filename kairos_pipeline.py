"""
kairos/pipeline.py
==================
통합 발굴 루프 — 8개 모듈을 하나의 폐루프로 엮는다 (CLAUDE.md §4 전체).

  생성기(thesis 강제)            kairos_generator
    → DSL 인과 시그널            kairos_dsl (룩어헤드 차단)
    → 현실화 백테스트            kairos_simulator (다음 바 체결/비용/캐퍼시티)
    → PIT 편향 점검              kairos_pit (생존편향/같은 바 누수)
    → 통계 게이트                kairos_harness (전역 시도원장 + DSR/안정성/레짐)
    → 승격                       kairos_promotion (PAPER…휴먼게이트…LIVE)
  실패하면 → supervisor 처치 후 발굴 재개   kairos_supervisor

이 모듈은 '오케스트레이션'만 한다. 각 단계의 규칙은 해당 모듈이 소유한다.
실데이터는 아직 합성/인메모리(라이브 가정) — bars 는 호출자가 공급한다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

import numpy as np

from kairos_dsl import CausalSeries
from kairos_generator import Candidate, GeneticGenerator
from kairos_harness import GateThresholds, TrialLedger, evaluate_strategy
from kairos_promotion import PAPER, PromotionPipeline
from kairos_pit import PITUniverse
from kairos_simulator import KoreanCostModel, RealizationSimulator, capacity_analysis
from kairos_supervisor import (
    DATA,
    LIQUIDITY,
    OVERFIT,
    FailureEvent,
    Supervisor,
)
from kairos_verifier import sharpe

# 결과 상태
PROMOTED_PAPER = "PROMOTED_PAPER"
REJECTED_OVERFIT = "REJECTED_OVERFIT"
REJECTED_LIQUIDITY = "REJECTED_LIQUIDITY"
BLOCKED_BIASED_DATA = "BLOCKED_BIASED_DATA"


@dataclass
class CandidateOutcome:
    sid: str
    category: str
    status: str
    backtest_sharpe: float = 0.0
    detail: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# 현실화 백테스트: DSL 인과 시그널 -> 비용 차감 수익률
# ---------------------------------------------------------------------------
def backtest_candidate(candidate: Candidate,
                       closes: list[float],
                       volumes: list[float] | None,
                       cost_model: KoreanCostModel,
                       instrument: str = "eq",
                       participation: float = 0.02) -> tuple[np.ndarray, float]:
    """
    인과적으로(룩어헤드 없이) 시그널을 만들고, 다음 바 수익률에 비용을 차감.
      - 결정은 바 t 까지의 정보로 (CausalSeries), 체결/수익은 t->t+1 (다음 바).
      - 포지션 변경분(turnover)에 한국 비용(매도거래세 포함)을 bp 로 차감.
    반환: (per-bar 순수익률 배열, turnover 비율)
    """
    n = len(closes)
    cseries = CausalSeries(closes, name="close")   # 인과성 보증 (DSL)
    pos_prev = 0
    rets, changes = [], 0
    # 비용: 대표 one-way (매수/매도 평균). 매도엔 거래세 포함.
    sigma_bps = 8.0
    buy_bps = cost_model.one_way_bps("buy", instrument, participation, sigma_bps)
    sell_bps = cost_model.one_way_bps("sell", instrument, participation, sigma_bps)
    avg_one_way = 0.5 * (buy_bps + sell_bps)

    for t in range(n - 1):                          # 마지막 바는 다음 바가 없음
        cseries.seek(t)
        window = {"close": closes[:t + 1]}
        if volumes is not None:
            window["volume"] = volumes[:t + 1]
        pos = candidate.signal(window)              # -1/0/+1, 인과적
        # t -> t+1 시장 수익률
        mkt = closes[t + 1] / closes[t] - 1.0
        gross = pos * mkt
        # 포지션 변경 비용 (turnover)
        delta = abs(pos - pos_prev)
        cost = delta * avg_one_way / 1e4
        if delta > 0:
            changes += 1
        rets.append(gross - cost)
        pos_prev = pos

    turnover = changes / max(1, n - 1)
    return np.asarray(rets, dtype=float), turnover


# ---------------------------------------------------------------------------
# 통합 파이프라인
# ---------------------------------------------------------------------------
@dataclass
class DiscoveryPipeline:
    generator: GeneticGenerator
    simulator: RealizationSimulator
    ledger: TrialLedger
    promotion: PromotionPipeline
    supervisor: Supervisor
    thresholds: GateThresholds = field(default_factory=GateThresholds)
    n_folds: int = 6
    instrument: str = "eq"

    @property
    def cost_model(self) -> KoreanCostModel:
        return self.simulator.cost_model

    def _capacity_ok(self, target_notional: float, adv_krw: float) -> bool:
        """시뮬레이터의 캐퍼시티 관점: 목표를 합리적 일수 안에 소화 가능한가."""
        cap = capacity_analysis(adv_krw, target_notional,
                                self.simulator.max_participation)
        return cap.days_to_fill_ceil <= 5      # 5거래일 내 소화 못하면 현실화 실패

    def evaluate_one(self, candidate: Candidate,
                     closes: list[float], volumes: list[float] | None,
                     regimes: np.ndarray | None,
                     adv_krw: float, target_notional: float,
                     sid: str) -> CandidateOutcome:
        cat = candidate.thesis.category

        # 1) 현실화 캐퍼시티 점검 (시뮬레이터)
        if not self._capacity_ok(target_notional, adv_krw):
            t = self.supervisor.treat(FailureEvent(LIQUIDITY, sid=sid,
                                                   detail={"target": target_notional}))
            return CandidateOutcome(sid, cat, REJECTED_LIQUIDITY,
                                    detail={"treatment": t.action})

        # 2) 현실화 백테스트 (DSL 인과 시그널 + 비용)
        rets, turnover = backtest_candidate(
            candidate, closes, volumes, self.cost_model, self.instrument)
        bt_sr = sharpe(rets)

        # 수익률은 다음 바 기준이라 길이가 len(closes)-1. regimes 도 결정시점에 정렬.
        reg = regimes[:len(rets)] if regimes is not None else None

        # 3) 통계 게이트 (전역 시도원장 + DSR/안정성/레짐)
        verdict = evaluate_strategy(rets, self.ledger, regimes=reg,
                                    thresholds=self.thresholds, n_folds=self.n_folds)

        # 4) 승격 or 처치
        if verdict.passed:
            self.promotion.admit(sid, backtest_passed=True, backtest_sharpe=bt_sr)
            return CandidateOutcome(sid, cat, PROMOTED_PAPER, bt_sr,
                                    detail={"dsr": verdict.dsr, "turnover": turnover})
        t = self.supervisor.treat(FailureEvent(OVERFIT, sid=sid,
                                               detail={"dsr": verdict.dsr}))
        return CandidateOutcome(sid, cat, REJECTED_OVERFIT, bt_sr,
                                detail={"dsr": verdict.dsr, "reasons": verdict.reasons,
                                        "treatment": t.action})

    def run(self, closes: list[float], volumes: list[float] | None = None,
            n_candidates: int = 10, regimes: np.ndarray | None = None,
            adv_krw: float = 5_000_000_000, target_notional: float = 1_000_000_000,
            universe: PITUniverse | None = None,
            asof: date | None = None) -> list[CandidateOutcome]:
        """
        한 번의 발굴 라운드: n_candidates 개를 생성·검증·승격/처치.
        universe/asof 가 주어지면 PIT 생존편향 점검을 먼저 한다(편향 구간이면 중단).
        """
        # 0) PIT 편향 점검 (생존편향 = 룩어헤드의 일종)
        if universe is not None and asof is not None and not universe.is_unbiased_asof(asof):
            self.supervisor.treat(FailureEvent(DATA, detail={"asof": asof.isoformat(),
                                                             "reason": "survivorship"}))
            return [CandidateOutcome("-", "-", BLOCKED_BIASED_DATA,
                                     detail={"asof": asof.isoformat()})]

        outcomes = []
        for i in range(n_candidates):
            cand = self.generator.make_candidate()
            outcomes.append(self.evaluate_one(
                cand, closes, volumes, regimes, adv_krw, target_notional,
                sid=f"cand-{i:03d}"))
        return outcomes


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import random

    rng = np.random.default_rng(7)

    # 합성 시세: 약한 모멘텀 + 노이즈 (라이브 가정 — 실데이터 미연동)
    n = 1200
    drift = np.linspace(0, 0.4, n)
    closes = (100 * np.exp(drift + np.cumsum(rng.normal(0, 0.01, n)))).tolist()
    volumes = (rng.lognormal(18, 0.3, n)).tolist()
    regimes = np.where(np.arange(n) % 2 == 0, "bull", "bear")

    pipe = DiscoveryPipeline(
        generator=GeneticGenerator(rng=random.Random(1), max_depth=2),
        simulator=RealizationSimulator(),
        ledger=TrialLedger(path=None),
        promotion=PromotionPipeline(),
        supervisor=Supervisor(),
    )

    print("=== 통합 발굴 라운드 (12 후보) ===")
    outs = pipe.run(closes, volumes, n_candidates=12, regimes=regimes)
    from collections import Counter
    status = Counter(o.status for o in outs)
    for o in outs:
        print(f"  {o.sid} [{o.category:14s}] {o.status:18s} bt_sr={o.backtest_sharpe:+.3f}")
    print("\n상태 요약:", dict(status))
    print("원장 누적 시도 N =", pipe.ledger.n_trials)
    print("supervisor 실패모드:", pipe.supervisor.log.mode_counts())

    print("\n=== 성공 경로: 진짜 추세 + 모멘텀 후보 -> PAPER 승격 ===")
    from kairos_generator import TERMINALS, Candidate, Node, Thesis
    mom = next(t for t in TERMINALS if t.name == "mom5")
    strong_close = (100 * np.exp(np.cumsum(
        np.random.default_rng(3).normal(0.003, 0.005, 800)))).tolist()
    cand = Candidate(Node("term", terminal=mom), Thesis("behavioral", "추세 추종 모멘텀"))
    out = pipe.evaluate_one(cand, strong_close, None, None,
                            adv_krw=5_000_000_000, target_notional=1_000_000_000,
                            sid="strong")
    print(f"  {out.sid} -> {out.status} bt_sr={out.backtest_sharpe:+.3f} dsr={out.detail.get('dsr')}")
    print(f"  승격 단계: {pipe.promotion.get('strong').stage}")

    print("\n=== 생존편향 구간이면 발굴 자체를 막는다 ===")
    uni = PITUniverse(coverage_start=date(2020, 1, 1))
    biased = pipe.run(closes, volumes, n_candidates=5,
                      universe=uni, asof=date(2018, 1, 1))
    print(" ", biased[0].status, biased[0].detail)
