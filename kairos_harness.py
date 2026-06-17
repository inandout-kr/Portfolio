"""
kairos/harness.py
=================
통계 검증 하니스 — 발굴 파이프라인 ④단계 (CLAUDE.md §4, §10-6).

"생성은 쉽다. 검증기가 전부다"(§2)를 실제 게이트로 묶는다:
  - 전역 시도 원장(TrialLedger): DSR 의 N 은 *루프 전체 역사*의 누적 시도 수여야
    한다(§2, §4-④). 영구 저장(JSON)해 세션이 바뀌어도 다중검정 보정이 유지된다.
  - 워크포워드 OOS + 안정성: 구간별 샤프가 들쭉날쭉하면 과최적화 신호(§3).
  - 레짐 강건성: 레짐을 바꿔도 부호가 유지되는가.
  - DSR / PBO: kairos_verifier 에 위임. 여기선 '원장 연동 + 게이트' 만 담당.

라이브 가정: 실제 전략 PnL 시계열은 백테스트 엔진/시뮬레이터가 만든다.
이 모듈은 그 수익률 배열을 받아 통과/기각을 판정한다.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import numpy as np

from kairos_verifier import deflated_sharpe_ratio, pbo_cscv, sharpe


# ---------------------------------------------------------------------------
# 1) 전역 시도 원장 (DSR 다중검정 보정의 핵심)
# ---------------------------------------------------------------------------
@dataclass
class TrialLedger:
    """
    모든 검증 시도의 per-period 샤프를 누적 기록. DSR 은 여기서 N 과 분산을 읽는다.
    path=None 이면 메모리 전용(테스트용), 경로를 주면 JSON 으로 영구화.
    """
    path: str | None = None
    _sharpes: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.path and os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as f:
                self._sharpes = list(json.load(f).get("sharpes", []))

    def record(self, sr: float) -> None:
        self._sharpes.append(float(sr))
        if self.path:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump({"sharpes": self._sharpes}, f)

    @property
    def n_trials(self) -> int:
        return len(self._sharpes)

    def sr_variance(self, fallback: float = 0.004) -> float:
        """기록된 시도들 간 per-period 샤프 분산. 표본<2면 fallback."""
        if len(self._sharpes) < 2:
            return fallback
        return float(np.var(self._sharpes, ddof=1))


# ---------------------------------------------------------------------------
# 2) 워크포워드 / 안정성 / 레짐
# ---------------------------------------------------------------------------
@dataclass
class WalkForwardReport:
    fold_sharpes: list[float]
    mean_sharpe: float
    frac_positive: float       # 양(+) 샤프 구간 비율 (안정성)
    worst_sharpe: float


def walk_forward(returns: np.ndarray, n_folds: int = 5) -> WalkForwardReport:
    """수익률을 n_folds 연속 구간으로 잘라 구간별 샤프(=OOS 안정성 프록시)."""
    r = np.asarray(returns, dtype=float)
    if n_folds < 2:
        raise ValueError("n_folds must be >= 2")
    if len(r) < n_folds:
        raise ValueError("not enough data for folds")
    folds = np.array_split(r, n_folds)
    srs = [sharpe(f) for f in folds]
    return WalkForwardReport(
        fold_sharpes=srs,
        mean_sharpe=float(np.mean(srs)),
        frac_positive=float(np.mean([s > 0 for s in srs])),
        worst_sharpe=float(np.min(srs)),
    )


def regime_robustness(returns: np.ndarray, regimes: np.ndarray) -> dict:
    """레짐 라벨별 샤프. 부호가 갈리면 강건하지 않음."""
    r = np.asarray(returns, dtype=float)
    g = np.asarray(regimes)
    if len(r) != len(g):
        raise ValueError("returns/regimes length mismatch")
    return {str(lab): sharpe(r[g == lab]) for lab in np.unique(g)}


# ---------------------------------------------------------------------------
# 3) 종합 게이트
# ---------------------------------------------------------------------------
@dataclass
class GateThresholds:
    min_dsr: float = 0.95           # DSR 통과 기준 확률
    min_frac_positive: float = 0.6  # 구간 안정성
    require_all_regimes_positive: bool = True


@dataclass
class Verdict:
    passed: bool
    dsr: float
    n_trials: int
    walk_forward: WalkForwardReport
    regimes: dict | None
    reasons: list[str]


def evaluate_strategy(returns: np.ndarray,
                      ledger: TrialLedger,
                      regimes: np.ndarray | None = None,
                      thresholds: GateThresholds | None = None,
                      n_folds: int = 5) -> Verdict:
    """
    한 전략 수익률을 검증하고 통과/기각 판정. *반드시 원장에 시도를 기록*한 뒤,
    그 누적 N 으로 DSR 을 계산한다(다중검정 보정).
    """
    th = thresholds or GateThresholds()
    r = np.asarray(returns, dtype=float)

    # 1) 시도 기록 (DSR 의 N 을 키운다) — 기록 후의 N 을 쓴다.
    ledger.record(sharpe(r))
    n = ledger.n_trials
    srv = ledger.sr_variance()

    # 2) DSR
    dsr = deflated_sharpe_ratio(r, n_trials=n, sr_variance=srv)

    # 3) 워크포워드 안정성
    wf = walk_forward(r, n_folds=n_folds)

    # 4) 레짐
    reg = regime_robustness(r, regimes) if regimes is not None else None

    reasons = []
    if dsr < th.min_dsr:
        reasons.append(f"DSR {dsr:.3f} < {th.min_dsr} (N={n} 다중검정)")
    if wf.frac_positive < th.min_frac_positive:
        reasons.append(f"안정성 부족: 양수 구간 {wf.frac_positive:.0%} < {th.min_frac_positive:.0%}")
    if reg is not None and th.require_all_regimes_positive and any(v <= 0 for v in reg.values()):
        bad = [k for k, v in reg.items() if v <= 0]
        reasons.append(f"레짐 취약: {bad}")

    return Verdict(
        passed=not reasons, dsr=dsr, n_trials=n,
        walk_forward=wf, regimes=reg, reasons=reasons,
    )


def backtest_overfit_prob(returns_matrix: np.ndarray, n_splits: int = 16) -> float:
    """다전략 선택의 PBO. kairos_verifier.pbo_cscv 래퍼 (편의)."""
    return pbo_cscv(returns_matrix, n_splits=n_splits)


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(11)
    ledger = TrialLedger(path=None)   # 데모는 메모리 전용

    print("=== 1) 원장이 비었을 때 (N 작음) 강한 알파 ===")
    strong = rng.normal(0.0025, 0.01, 1260)
    v1 = evaluate_strategy(strong, ledger, n_folds=6)
    print(f"  N={v1.n_trials} DSR={v1.dsr:.3f} 통과={v1.passed} 사유={v1.reasons}")

    print("=== 2) 시도를 9999번 더 쌓은 뒤 같은 알파 (다중검정 압박) ===")
    for _ in range(9999):
        ledger.record(rng.normal(0.05, 0.06))   # 과거 시도들의 샤프 분포
    v2 = evaluate_strategy(strong, ledger, n_folds=6)
    print(f"  N={v2.n_trials} DSR={v2.dsr:.3f} 통과={v2.passed} 사유={v2.reasons}")

    print("=== 3) 레짐 강건성 ===")
    regimes = np.where(np.arange(1260) % 2 == 0, "bull", "bear")
    fragile = strong.copy()
    fragile[regimes == "bear"] = rng.normal(-0.002, 0.01, (regimes == "bear").sum())
    v3 = evaluate_strategy(fragile, TrialLedger(), regimes=regimes, n_folds=6)
    print(f"  레짐별 샤프={ {k: round(x,3) for k,x in v3.regimes.items()} } 통과={v3.passed}")
    print(f"  사유={v3.reasons}")

    print("=== 4) PBO (다전략) ===")
    M = rng.normal(0, 0.01, (1500, 30)); M[:, 0] += 0.002
    print(f"  PBO={backtest_overfit_prob(M, 10):.3f} (한 전략만 지속알파)")
