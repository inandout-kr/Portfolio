"""
kairos/supervisor.py
====================
바깥쪽 supervisor 루프 — 막히면 스스로 진단·처치하고 발굴로 복귀 (CLAUDE.md §4, §10-8).

상태머신: 실패 분류 → 진단 → 처치 → 발굴 재개

처치 정책 (§4 바깥쪽 루프)
  - 데이터 결손/이상치        → 클리닝 후 재개
  - 유동성 부족(현실화 실패)  → 재파라미터화, 반복되면 폐기
  - 과최적화(DSR/PBO 실패)    → 폐기, 반복 패턴이면 *가드 강화* 학습
  - 라이브 vs 백테스트 괴리   → 원인 진단(레짐/비용모델/알파감쇠)
                                 → 재캘리브 or 은퇴

영구 상태 (§4)
  - 실패 로그(FailureLog): 반복 실패 모드를 학습 → 임계 넘으면 처치를 격상.
    JSON 영구화(.kairos/, gitignore)해 세션이 바뀌어도 학습이 누적된다.
  - 전역 시도 원장은 kairos_harness.TrialLedger 가 담당(여기선 참조만).
"""
from __future__ import annotations

import json
import os
from collections import Counter
from dataclasses import dataclass, field

# 실패 유형
DATA = "DATA"                       # 결손/이상치
LIQUIDITY = "LIQUIDITY"             # 현실화(체결/캐퍼시티) 실패
OVERFIT = "OVERFIT"                 # DSR/PBO 등 통계 게이트 실패
LIVE_DIVERGENCE = "LIVE_DIVERGENCE" # 라이브 vs 백테스트 괴리
FAILURE_TYPES = (DATA, LIQUIDITY, OVERFIT, LIVE_DIVERGENCE)

# 라이브 괴리 하위원인
REGIME = "regime"
COST_MODEL = "cost_model"
ALPHA_DECAY = "alpha_decay"

# 처치 액션
RESUME = "CLEAN_RESUME"
REPARAMETRIZE = "REPARAMETRIZE"
DISCARD = "DISCARD"
RECALIBRATE = "RECALIBRATE"
RETIRE = "RETIRE"
STRENGTHEN_GUARD = "STRENGTHEN_GUARD"


@dataclass
class FailureEvent:
    ftype: str
    sid: str | None = None
    detail: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.ftype not in FAILURE_TYPES:
            raise ValueError(f"unknown failure type: {self.ftype}")


@dataclass
class Treatment:
    action: str
    reason: str
    resumes_discovery: bool = True   # 바깥 루프의 목적: 결국 발굴로 복귀


@dataclass
class FailureLog:
    """실패 이벤트 누적 + 영구화. 반복 실패 모드 학습용."""
    path: str | None = None
    _events: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.path and os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as f:
                self._events = list(json.load(f).get("events", []))

    def record(self, event: FailureEvent) -> None:
        self._events.append({"ftype": event.ftype, "sid": event.sid,
                             "detail": event.detail})
        if self.path:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump({"events": self._events}, f)

    def count(self, ftype: str) -> int:
        return sum(1 for e in self._events if e["ftype"] == ftype)

    def mode_counts(self) -> dict:
        return dict(Counter(e["ftype"] for e in self._events))


@dataclass
class SupervisorPolicy:
    repeat_threshold: int = 3        # 같은 실패가 이만큼 쌓이면 처치 격상


class Supervisor:
    """실패를 받아 처치를 결정하고, 반복 패턴은 격상한다."""

    def __init__(self, log: FailureLog | None = None,
                 policy: SupervisorPolicy | None = None):
        self.log = log or FailureLog()
        self.policy = policy or SupervisorPolicy()

    def treat(self, event: FailureEvent) -> Treatment:
        self.log.record(event)
        n = self.log.count(event.ftype)
        repeated = n >= self.policy.repeat_threshold

        if event.ftype == DATA:
            return Treatment(RESUME, "데이터 클리닝 후 재개")

        if event.ftype == LIQUIDITY:
            if repeated:
                return Treatment(DISCARD, f"유동성 실패 반복({n}회) → 폐기")
            return Treatment(REPARAMETRIZE, "참여율/사이즈 재파라미터화 후 재개")

        if event.ftype == OVERFIT:
            if repeated:
                return Treatment(STRENGTHEN_GUARD,
                                 f"과최적화 반복({n}회) → 가드 강화 학습")
            return Treatment(DISCARD, "DSR/PBO 미통과 → 폐기")

        if event.ftype == LIVE_DIVERGENCE:
            return self._treat_divergence(event)

        # 도달 불가 (생성자에서 검증됨)
        raise ValueError(event.ftype)

    def _treat_divergence(self, event: FailureEvent) -> Treatment:
        sub = event.detail.get("subtype")
        if sub == REGIME:
            return Treatment(RECALIBRATE, "레짐 변화 → 레짐 조건부 재캘리브")
        if sub == COST_MODEL:
            return Treatment(RECALIBRATE, "비용모델 과소추정 → 비용 재캘리브")
        if sub == ALPHA_DECAY:
            return Treatment(RETIRE, "알파 감쇠 확인 → 은퇴")
        return Treatment(DISCARD, "원인 미상 괴리 → 보수적 폐기")

    @staticmethod
    def diagnose_divergence(detail: dict) -> str:
        """
        라이브 괴리의 하위원인 휴리스틱 진단.
          - 레짐 지표 급변      -> regime
          - 실현 슬리피지 > 모델 -> cost_model
          - 포워드<백테스트 지속 -> alpha_decay
        """
        if detail.get("regime_shift"):
            return REGIME
        if detail.get("realized_slippage_bps", 0) > detail.get("modeled_slippage_bps", 0):
            return COST_MODEL
        if detail.get("forward_below_backtest"):
            return ALPHA_DECAY
        return "unknown"


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    sup = Supervisor(policy=SupervisorPolicy(repeat_threshold=3))

    print("=== 1) 데이터 결손 -> 클리닝 후 재개 ===")
    print(" ", sup.treat(FailureEvent(DATA, detail={"missing_bars": 12})))

    print("=== 2) 유동성 실패: 처음엔 재파라미터화, 반복되면 폐기 ===")
    for i in range(4):
        t = sup.treat(FailureEvent(LIQUIDITY, sid="alpha-9"))
        print(f"  {i+1}회차 -> {t.action} ({t.reason})")

    print("=== 3) 과최적화 반복 -> 가드 강화 학습 ===")
    for i in range(3):
        t = sup.treat(FailureEvent(OVERFIT, sid="alpha-x"))
        print(f"  {i+1}회차 -> {t.action}")

    print("=== 4) 라이브 괴리 진단 -> 처치 ===")
    for detail in [
        {"regime_shift": True},
        {"realized_slippage_bps": 40, "modeled_slippage_bps": 20},
        {"forward_below_backtest": True},
    ]:
        sub = Supervisor.diagnose_divergence(detail)
        t = sup.treat(FailureEvent(LIVE_DIVERGENCE, sid="alpha-7",
                                   detail={"subtype": sub}))
        print(f"  진단={sub:11s} -> {t.action} ({t.reason})")

    print("=== 5) 누적 실패 모드 (학습 상태) ===")
    print(" ", sup.log.mode_counts())
