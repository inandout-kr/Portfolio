"""
kairos/simulator.py
===================
현실화 시뮬레이터 — "백테스트 상의 체결"을 "한국 시장에서 실제로 가능한 체결"로
강등시키는 모듈. 발굴 파이프라인 ③단계 (CLAUDE.md §4, §10-2).

핵심 도그마 (CLAUDE.md §2)
  - 체결은 *결정한 바*가 아니라 *다음 바*부터 일어난다 (look-ahead 차단).
  - 비용은 항상 보수적으로. 슬리피지는 데이터에 없으니 반드시 모델링한다.
  - 한국 시장 특수성은 타협 대상이 아니다:
      매도 거래세, 공매도 차입제약, 가격제한(±30%), 서킷브레이커/VI 정지,
      그리고 한 바의 거래대금을 다 먹을 수 없다는 캐퍼시티 한계.

이 모듈은 비용 자체는 kairos_verifier.KoreanCostModel 에 위임하고,
"언제/얼마나 체결되는가" 라는 *체결 가능성/캐퍼시티* 문제에 집중한다.

용어
  - participation : (이번 바에서 체결한 금액) / (그 바의 거래대금)
  - ref price     : 체결 기준가. 같은 바 종가가 아니라 다음 바들의 typical price.
  - all-in price  : 수수료+거래세+슬리피지를 전부 가격에 접은 실효 체결가.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from kairos_verifier import KoreanCostModel

KRX_PRICE_LIMIT_PCT = 0.30  # 코스피/코스닥 일일 가격제한폭 ±30%
_EPS = 1e-9


# ---------------------------------------------------------------------------
# 시장 데이터 / 주문 / 체결 타입
# ---------------------------------------------------------------------------
@dataclass
class Bar:
    """1분봉 한 개. value = 그 바의 거래대금(KRW)."""
    open: float
    high: float
    low: float
    close: float
    value: float                      # 거래대금 (KRW)
    halted: bool = False              # VI / 서킷브레이커 정지 -> 체결 불가
    limit_up: float | None = None     # 명시 안 하면 prev_close 로 계산
    limit_down: float | None = None

    @property
    def typical(self) -> float:
        """체결 기준가 프록시 (VWAP 근사). 같은 바 종가 단일가정의 낙관 회피."""
        return (self.high + self.low + self.close) / 3.0

    @property
    def range_bps(self) -> float:
        """바 내 변동폭(bp). 슬리피지 sigma 프록시 (보수적으로 full range 사용)."""
        ref = self.typical
        return (self.high - self.low) / ref * 1e4 if ref > 0 else 0.0


@dataclass
class Order:
    """다음 바부터 체결을 시도할 주문. shares > 0."""
    side: str            # 'buy' | 'sell'
    instrument: str      # 'eq' | 'fut'
    shares: float        # 체결하려는 수량 (양수)
    is_short: bool = False  # 현물 매도가 '공매도'면 차입 가능성 필요

    def __post_init__(self) -> None:
        if self.side not in ("buy", "sell"):
            raise ValueError(f"side must be buy|sell: {self.side}")
        if self.instrument not in ("eq", "fut"):
            raise ValueError(f"instrument must be eq|fut: {self.instrument}")
        if self.shares <= 0:
            raise ValueError("shares must be positive")


@dataclass
class Fill:
    """한 바에서의 부분 체결."""
    bar: int             # future_bars 내 인덱스 (0 = 다음 바)
    shares: float
    ref_price: float
    fill_price: float    # all-in (수수료+세금+슬리피지 포함)
    cost_bps: float
    cost_krw: float


@dataclass
class ExecutionReport:
    order: Order
    fills: list[Fill] = field(default_factory=list)
    rejected: bool = False
    reason: str | None = None

    @property
    def filled_shares(self) -> float:
        return sum(f.shares for f in self.fills)

    @property
    def remaining_shares(self) -> float:
        """체결 못 하고 남은 수량 = 캐퍼시티/유동성 부족분."""
        return max(0.0, self.order.shares - self.filled_shares)

    @property
    def fully_filled(self) -> bool:
        return self.remaining_shares <= _EPS and not self.rejected

    @property
    def avg_fill_price(self) -> float:
        f = self.filled_shares
        if f <= 0:
            return 0.0
        return sum(x.shares * x.fill_price for x in self.fills) / f

    @property
    def total_cost_krw(self) -> float:
        return sum(x.cost_krw for x in self.fills)

    @property
    def arrival_price(self) -> float:
        """첫 체결 가능 바의 기준가 (implementation shortfall 기준점)."""
        return self.fills[0].ref_price if self.fills else 0.0

    @property
    def slippage_bps(self) -> float:
        """
        실효 체결가 vs arrival price 의 implementation shortfall (bp).
        비용 + 시장 드리프트 + 캐퍼시티 지연을 한 숫자로. 매수는 +가 손해.
        """
        arr = self.arrival_price
        avg = self.avg_fill_price
        if arr <= 0 or avg <= 0:
            return 0.0
        sign = 1.0 if self.order.side == "buy" else -1.0
        return sign * (avg / arr - 1.0) * 1e4


# ---------------------------------------------------------------------------
# 현실화 시뮬레이터
# ---------------------------------------------------------------------------
@dataclass
class RealizationSimulator:
    """
    주문 하나를 다음 바들에 대고 굴려 '실제로 가능한 체결'을 만든다.

    파라미터
      max_participation : 한 바에서 먹을 수 있는 거래대금 비율 상한 (캐퍼시티).
      borrowable_short  : 유니버스의 공매도 차입 가능 여부 (코스피200급=대체로 가능).
      limit_pct         : 일일 가격제한폭 (KRX ±30%).
    """
    cost_model: KoreanCostModel = field(default_factory=KoreanCostModel)
    max_participation: float = 0.10
    borrowable_short: bool = True
    limit_pct: float = KRX_PRICE_LIMIT_PCT

    def _limits(self, bar: Bar, prev_close: float | None) -> tuple[float | None, float | None]:
        lu, ld = bar.limit_up, bar.limit_down
        if prev_close is not None:
            if lu is None:
                lu = prev_close * (1 + self.limit_pct)
            if ld is None:
                ld = prev_close * (1 - self.limit_pct)
        return lu, ld

    def _locked(self, bar: Bar, side: str, lu: float | None, ld: float | None) -> bool:
        """가격제한에 '잠긴' 바인지. 상한가 잠김이면 매수 불가, 하한가 잠김이면 매도 불가."""
        if side == "buy" and lu is not None and bar.low >= lu - _EPS:
            return True   # 상한가 잠김: 살 물량이 없다
        if side == "sell" and ld is not None and bar.high <= ld + _EPS:
            return True   # 하한가 잠김: 받아줄 사람이 없다
        return False

    def execute(self, order: Order, future_bars: list[Bar],
                prev_close: float | None = None) -> ExecutionReport:
        """
        order 를 future_bars[0](=다음 바)부터 순서대로 체결 시도.
        한 바의 거래대금 max_participation 까지만 먹고 나머지는 다음 바로 이월.
        끝까지 못 먹으면 remaining_shares 로 남는다 (캐퍼시티 부족).
        """
        report = ExecutionReport(order=order)

        # 공매도 차입 제약: 현물 공매도인데 차입 불가면 통째로 기각.
        if order.instrument == "eq" and order.is_short and not self.borrowable_short:
            report.rejected = True
            report.reason = "short not borrowable"
            return report

        remaining = order.shares
        for i, bar in enumerate(future_bars):
            if remaining <= _EPS:
                break
            if bar.halted:                      # VI / 서킷브레이커 -> 이번 바 체결 불가
                continue
            if bar.value <= 0:                  # 거래 없음
                continue

            lu, ld = self._limits(bar, prev_close)
            if self._locked(bar, order.side, lu, ld):
                continue

            ref = bar.typical
            if ref <= 0:
                continue

            max_shares = (self.max_participation * bar.value) / ref
            take = min(remaining, max_shares)
            if take <= _EPS:
                continue

            participation = (take * ref) / bar.value
            sigma_bps = bar.range_bps
            cost_bps = self.cost_model.one_way_bps(
                order.side, order.instrument, participation, sigma_bps
            )
            if order.side == "buy":
                fill_price = ref * (1 + cost_bps / 1e4)
            else:
                fill_price = ref * (1 - cost_bps / 1e4)
            cost_krw = take * ref * cost_bps / 1e4

            report.fills.append(Fill(
                bar=i, shares=take, ref_price=ref,
                fill_price=fill_price, cost_bps=cost_bps, cost_krw=cost_krw,
            ))
            remaining -= take

        if not report.fills:
            report.reason = report.reason or "no executable bar (halt/limit/no-liquidity)"
        return report


# ---------------------------------------------------------------------------
# 캐퍼시티 분석 (주문 크기 vs 유동성)
# ---------------------------------------------------------------------------
@dataclass
class CapacityReport:
    target_notional: float
    daily_capacity: float     # 하루에 소화 가능한 금액
    days_to_fill: float       # 다 채우는 데 걸리는 거래일 수 (올림 전)
    days_to_fill_ceil: int
    feasible_same_day: bool


def capacity_analysis(adv_krw: float, target_notional: float,
                      max_daily_participation: float = 0.10) -> CapacityReport:
    """
    ADV(평균 거래대금) 대비 목표 금액을 며칠에 걸쳐야 소화 가능한지.
    며칠씩 걸리면 알파가 그 사이 감쇠/누설되므로 사실상 캐퍼시티 한계.
    """
    if adv_krw <= 0:
        raise ValueError("adv_krw must be positive")
    daily_capacity = max_daily_participation * adv_krw
    days = target_notional / daily_capacity
    return CapacityReport(
        target_notional=target_notional,
        daily_capacity=daily_capacity,
        days_to_fill=days,
        days_to_fill_ceil=math.ceil(days - _EPS),
        feasible_same_day=days <= 1.0 + _EPS,
    )


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    sim = RealizationSimulator(max_participation=0.10)

    def flat_bars(price: float, value: float, n: int, spread_bps: float = 5.0) -> list[Bar]:
        h = price * (1 + spread_bps / 1e4)
        lo = price * (1 - spread_bps / 1e4)
        return [Bar(open=price, high=h, low=lo, close=price, value=value) for _ in range(n)]

    print("=== 1) 다음 바 체결 + 캐퍼시티 이월 ===")
    # 5만주 @ 1만원 = 5억 매수. 바당 거래대금 10억, 참여율 10% -> 바당 1억(=1만주)씩.
    order = Order("buy", "eq", shares=50_000)
    rep = sim.execute(order, flat_bars(10_000, value=1_000_000_000, n=10))
    print(f"체결 {rep.filled_shares:,.0f} / {order.shares:,.0f} 주, "
          f"{len(rep.fills)} 바에 걸침, 잔여 {rep.remaining_shares:,.0f}")
    print(f"평균체결가 {rep.avg_fill_price:,.1f}  (기준가 10,000) "
          f"implementation shortfall {rep.slippage_bps:+.1f}bp")
    print(f"총비용 {rep.total_cost_krw:,.0f} KRW\n")

    print("=== 2) 가격제한(상한가 잠김) -> 매수 불가 ===")
    locked = [Bar(open=13_000, high=13_000, low=13_000, close=13_000,
                  value=5_000_000, limit_up=13_000) for _ in range(3)]
    rep2 = sim.execute(Order("buy", "eq", 1_000), locked, prev_close=10_000)
    print(f"체결 {rep2.filled_shares:,.0f} 주, 사유: {rep2.reason}\n")

    print("=== 3) VI/서킷 정지 바는 건너뜀 ===")
    bars = flat_bars(10_000, 1_000_000_000, 4)
    bars[0].halted = True
    bars[1].halted = True
    rep3 = sim.execute(Order("buy", "eq", 1_000), bars)
    print(f"첫 체결 바 인덱스 = {rep3.fills[0].bar}  (0,1 정지 -> 2부터)\n")

    print("=== 4) 공매도 차입 불가 -> 기각 ===")
    sim_noborrow = RealizationSimulator(borrowable_short=False)
    rep4 = sim_noborrow.execute(Order("sell", "eq", 1_000, is_short=True),
                                flat_bars(10_000, 1_000_000_000, 3))
    print(f"rejected={rep4.rejected}, reason={rep4.reason}\n")

    print("=== 5) 캐퍼시티 분석 ===")
    cap = capacity_analysis(adv_krw=5_000_000_000, target_notional=3_000_000_000,
                            max_daily_participation=0.10)
    print(f"목표 {cap.target_notional:,.0f} / 일일소화 {cap.daily_capacity:,.0f} "
          f"-> {cap.days_to_fill:.1f}일 (당일가능={cap.feasible_same_day})")
