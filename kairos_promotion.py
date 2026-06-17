"""
kairos/promotion.py
===================
승격 게이트 + 페이퍼 + 라이브 피드백 — 발굴 파이프라인 ⑤단계 (CLAUDE.md §4, §10-7).

상태머신: BACKTEST → PAPER → FORWARD → (휴먼 게이트) → LIVE  /  실패시 RETIRED

도그마 강제 (§2)
  - 포워드/페이퍼 성과가 백테스트보다 우선. 페이퍼/포워드는 생존편향 면역(§8).
  - 백테스트 대비 포워드가 크게 죽으면(알파 감쇠) 승격 거부.
  - **라이브 자본 투입 전 휴먼 게이트는 제거 불가.** LIVE 로의 자동 승격은
    구조적으로 불가능하다 (human_approve 없이는 예외).
  - 라이브 피드백: 라이브 vs 백테스트 괴리를 측정해 바깥 supervisor(§10-8)에 넘김.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from kairos_verifier import sharpe

# 단계
BACKTEST = "BACKTEST"
PAPER = "PAPER"
FORWARD = "FORWARD"
LIVE = "LIVE"
RETIRED = "RETIRED"


@dataclass
class PromotionPolicy:
    min_paper_sharpe: float = 0.0       # 페이퍼 per-period 샤프 하한
    min_forward_sharpe: float = 0.0     # 포워드 하한
    max_decay_ratio: float = 0.5        # forward/backtest 가 이 미만이면 알파 감쇠로 거부
    min_samples: int = 30               # 페이퍼/포워드 판정 최소 표본
    live_divergence_tol: float = 0.5    # |live-backtest|/|backtest| 경보 임계


@dataclass
class StrategyRecord:
    sid: str
    backtest_sharpe: float
    stage: str = BACKTEST
    human_approved: bool = False
    paper_returns: list[float] = field(default_factory=list)
    forward_returns: list[float] = field(default_factory=list)
    live_returns: list[float] = field(default_factory=list)
    history: list[str] = field(default_factory=list)

    def log(self, msg: str) -> None:
        self.history.append(msg)


@dataclass
class PromotionDecision:
    promoted: bool
    stage: str
    reasons: list[str]


class PromotionPipeline:
    """승격 파이프라인. 한 번에 한 단계씩만 올린다."""

    def __init__(self, policy: PromotionPolicy | None = None):
        self.policy = policy or PromotionPolicy()
        self._strategies: dict[str, StrategyRecord] = {}

    # --- 진입 ---
    def admit(self, sid: str, backtest_passed: bool, backtest_sharpe: float) -> StrategyRecord:
        """통계 게이트(harness.Verdict) 통과분만 PAPER 로, 아니면 RETIRED."""
        rec = StrategyRecord(sid=sid, backtest_sharpe=backtest_sharpe)
        if backtest_passed:
            rec.stage = PAPER
            rec.log("admitted -> PAPER")
        else:
            rec.stage = RETIRED
            rec.log("backtest gate failed -> RETIRED")
        self._strategies[sid] = rec
        return rec

    def get(self, sid: str) -> StrategyRecord:
        return self._strategies[sid]

    # --- 성과 적재 ---
    def record_paper(self, sid: str, returns) -> None:
        self._strategies[sid].paper_returns.extend(np.asarray(returns, float).tolist())

    def record_forward(self, sid: str, returns) -> None:
        self._strategies[sid].forward_returns.extend(np.asarray(returns, float).tolist())

    def record_live(self, sid: str, returns) -> None:
        self._strategies[sid].live_returns.extend(np.asarray(returns, float).tolist())

    # --- 휴먼 게이트 (제거 불가) ---
    def human_approve(self, sid: str, approver: str) -> None:
        rec = self._strategies[sid]
        rec.human_approved = True
        rec.log(f"human approval by {approver}")

    # --- 승격 ---
    def try_promote(self, sid: str) -> PromotionDecision:
        rec = self._strategies[sid]
        p = self.policy

        if rec.stage == PAPER:
            reasons = self._check_perf(rec.paper_returns, p.min_paper_sharpe, "paper")
            if not reasons:
                rec.stage = FORWARD
                rec.log("PAPER -> FORWARD")
            return PromotionDecision(not reasons, rec.stage, reasons)

        if rec.stage == FORWARD:
            reasons = self._check_perf(rec.forward_returns, p.min_forward_sharpe, "forward")
            # 알파 감쇠: 포워드가 백테스트 대비 너무 죽으면 거부 (포워드 우선)
            if not reasons and rec.backtest_sharpe > 0:
                fwd = sharpe(np.asarray(rec.forward_returns, float))
                if fwd < p.max_decay_ratio * rec.backtest_sharpe:
                    reasons.append(
                        f"알파 감쇠: forward {fwd:.3f} < {p.max_decay_ratio}*backtest "
                        f"{rec.backtest_sharpe:.3f}"
                    )
            # 휴먼 게이트: LIVE 직전 필수
            if not reasons and not rec.human_approved:
                reasons.append("휴먼 게이트 미승인 (LIVE 자동 승격 불가)")
            if not reasons:
                rec.stage = LIVE
                rec.log("FORWARD -> LIVE (human-approved)")
            return PromotionDecision(not reasons, rec.stage, reasons)

        return PromotionDecision(False, rec.stage, [f"승격 불가 단계: {rec.stage}"])

    def _check_perf(self, returns: list[float], min_sharpe: float, label: str) -> list[str]:
        reasons = []
        if len(returns) < self.policy.min_samples:
            reasons.append(f"{label} 표본 부족: {len(returns)} < {self.policy.min_samples}")
            return reasons
        sr = sharpe(np.asarray(returns, float))
        if sr <= min_sharpe:
            reasons.append(f"{label} 성과 미달: 샤프 {sr:.3f} <= {min_sharpe}")
        return reasons

    # --- 라이브 피드백 (supervisor 입력) ---
    def live_divergence(self, sid: str) -> dict:
        """라이브 vs 백테스트 괴리. alert=True 면 §10-8 supervisor 가 진단."""
        rec = self._strategies[sid]
        if len(rec.live_returns) < self.policy.min_samples:
            return {"alert": False, "reason": "insufficient live samples"}
        live_sr = sharpe(np.asarray(rec.live_returns, float))
        base = rec.backtest_sharpe
        if base == 0:
            return {"alert": False, "live_sharpe": live_sr}
        divergence = abs(live_sr - base) / abs(base)
        return {
            "alert": divergence > self.policy.live_divergence_tol,
            "live_sharpe": live_sr,
            "backtest_sharpe": base,
            "divergence": divergence,
        }


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
def _series(n: int, target_sr: float, seed: int = 0) -> np.ndarray:
    """표본 per-period 샤프가 정확히 target_sr 인 수익률 (데모/테스트 결정성)."""
    x = np.random.default_rng(seed).normal(0.0, 0.01, n)
    x = x - x.mean()
    sd = x.std(ddof=1)
    return x + target_sr * sd


if __name__ == "__main__":
    pipe = PromotionPipeline()

    print("=== 1) 백테스트 통과 -> PAPER ===")
    rec = pipe.admit("alpha-1", backtest_passed=True, backtest_sharpe=0.18)
    print(f"  stage={rec.stage}")

    print("=== 2) 페이퍼 성과 적재 -> FORWARD ===")
    pipe.record_paper("alpha-1", _series(60, 0.15, seed=1))
    print(f"  {pipe.try_promote('alpha-1')}")

    print("=== 3) 포워드 OK 지만 휴먼 미승인 -> LIVE 거부 ===")
    pipe.record_forward("alpha-1", _series(60, 0.13, seed=2))
    print(f"  {pipe.try_promote('alpha-1')}")

    print("=== 4) 휴먼 승인 후 -> LIVE ===")
    pipe.human_approve("alpha-1", approver="kiunghan")
    print(f"  {pipe.try_promote('alpha-1')}")

    print("=== 5) 라이브 피드백: 괴리 경보 ===")
    pipe.record_live("alpha-1", _series(60, -0.30, seed=3))   # 라이브가 죽음
    print(f"  {pipe.live_divergence('alpha-1')}")

    print("=== 6) 알파 감쇠로 FORWARD 에서 거부 ===")
    pipe.admit("alpha-2", backtest_passed=True, backtest_sharpe=0.40)
    pipe.record_paper("alpha-2", _series(60, 0.15, seed=4))
    pipe.try_promote("alpha-2")
    pipe.record_forward("alpha-2", _series(200, 0.10, seed=5))  # 양수지만 크게 감쇠
    pipe.human_approve("alpha-2", "kiunghan")
    print(f"  {pipe.try_promote('alpha-2')}")
