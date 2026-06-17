"""
kairos/dsl.py
=============
Kairos 임베디드 DSL — 전략을 '룩어헤드가 표현 불가능한' 형태로 기술하기 위한
Python 라이브러리 (CLAUDE.md §5, §10-4, 결정 §11-3: 임베디드 DSL).

세 기둥(§5)을 라이브러리로:
  1) 차원·통화 타입 : Price<KRW> * Shares -> Notional<KRW> (OK),
     Price<KRW> + Price<USD> -> 에러. 단위 혼동을 런타임 타입으로 차단.
  2) 시간 안전성    : CausalSeries 는 자유 인덱싱 불가. now 기준 과거만 접근,
     미래 접근(ago(음수))은 LookAheadError. (= chronos vs kairos)
  3) 반응형 블록    : run_reactive 가 바를 하나씩 흘리며 on_bar 를 호출. 같은
     코드가 backtest/paper/live 에서 그대로 (실행 컨텍스트 다형성의 토대).

이 모듈은 사용자의 기존 백테스트 엔진 '위에' 얹는 얇은 계층이다. 비용/체결은
kairos_simulator, 통계는 kairos_verifier 가 담당한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


class LookAheadError(Exception):
    """미래(또는 같은 시점 이후) 데이터에 접근하려 할 때."""


# ---------------------------------------------------------------------------
# 1) 차원·통화 타입
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Price:
    value: float
    currency: str

    def _same_ccy(self, other: "Price") -> None:
        if self.currency != other.currency:
            raise TypeError(f"currency mismatch: {self.currency} vs {other.currency}")

    def __add__(self, other: "Price") -> "Price":
        if not isinstance(other, Price):
            raise TypeError("Price + non-Price")
        self._same_ccy(other)
        return Price(self.value + other.value, self.currency)

    def __sub__(self, other: "Price") -> "Price":
        if not isinstance(other, Price):
            raise TypeError("Price - non-Price")
        self._same_ccy(other)
        return Price(self.value - other.value, self.currency)

    def __mul__(self, other):
        if isinstance(other, Shares):
            return Notional(self.value * other.value, self.currency)
        if isinstance(other, (int, float)):
            return Price(self.value * other, self.currency)
        raise TypeError(f"Price * {type(other).__name__} undefined")

    __rmul__ = __mul__


@dataclass(frozen=True)
class Shares:
    value: float

    def __add__(self, other: "Shares") -> "Shares":
        if not isinstance(other, Shares):
            raise TypeError("Shares + non-Shares")
        return Shares(self.value + other.value)

    def __mul__(self, other):
        if isinstance(other, Price):
            return Notional(self.value * other.value, other.currency)
        if isinstance(other, (int, float)):
            return Shares(self.value * other)
        raise TypeError(f"Shares * {type(other).__name__} undefined")

    __rmul__ = __mul__


@dataclass(frozen=True)
class Notional:
    value: float
    currency: str

    def __add__(self, other: "Notional") -> "Notional":
        if not isinstance(other, Notional):
            raise TypeError("Notional + non-Notional")
        if self.currency != other.currency:
            raise TypeError(f"currency mismatch: {self.currency} vs {other.currency}")
        return Notional(self.value + other.value, self.currency)

    def __truediv__(self, other):
        if isinstance(other, Price):
            if self.currency != other.currency:
                raise TypeError(f"currency mismatch: {self.currency} vs {other.currency}")
            return Shares(self.value / other.value)   # 금액 / 가격 = 수량
        if isinstance(other, Shares):
            return Price(self.value / other.value, self.currency)  # 금액 / 수량 = 가격
        raise TypeError(f"Notional / {type(other).__name__} undefined")


# ---------------------------------------------------------------------------
# 2) 인과적 시계열 (시간 안전성)
# ---------------------------------------------------------------------------
class CausalSeries:
    """
    now 커서 기준으로 과거까지만 인과적으로 접근. 미래는 구조적으로 차단.
      - now()      : 현재 값
      - ago(k)     : k 바 전 값 (k>=0). 음수는 LookAheadError.
      - window(n)  : 최근 n개(현재 포함). 히스토리 부족하면 있는 만큼.
    엔진이 seek(t)/advance() 로 커서를 옮긴다. 인덱싱(__getitem__)은 막는다.
    """
    def __init__(self, data, name: str = "series"):
        self._data = list(data)
        self._t = 0
        self.name = name

    def __len__(self) -> int:
        return len(self._data)

    def seek(self, t: int) -> None:
        if not (0 <= t < len(self._data)):
            raise IndexError(f"seek out of range: {t}")
        self._t = t

    def advance(self) -> None:
        if self._t + 1 >= len(self._data):
            raise IndexError("advance past end")
        self._t += 1

    @property
    def t(self) -> int:
        return self._t

    def now(self):
        return self._data[self._t]

    def ago(self, k: int):
        if k < 0:
            raise LookAheadError(f"future access blocked: ago({k})")
        j = self._t - k
        if j < 0:
            return None                      # 히스토리 이전 = 알 수 없음
        return self._data[j]

    def window(self, n: int) -> list:
        if n <= 0:
            raise ValueError("n must be positive")
        lo = max(0, self._t - n + 1)
        return self._data[lo:self._t + 1]

    def __getitem__(self, idx):
        raise LookAheadError(
            "free indexing is forbidden on CausalSeries; use now()/ago(k)/window(n)"
        )


# ---------------------------------------------------------------------------
# 3) 반응형 블록 (실행 컨텍스트)
# ---------------------------------------------------------------------------
@dataclass
class Context:
    """on_bar 핸들러에 넘어가는 인과적 뷰. series 는 모두 같은 t 로 정렬돼 있다."""
    t: int
    series: dict[str, CausalSeries]

    def __getitem__(self, name: str) -> CausalSeries:
        return self.series[name]


def run_reactive(series: dict[str, CausalSeries],
                 on_bar: Callable[[Context], object]) -> list[tuple[int, object]]:
    """
    모든 시계열을 같은 길이로 보고 t=0..N-1 을 하나씩 흘리며 on_bar 호출.
    on_bar 가 None 이 아닌 값(예: 주문/시그널)을 내면 (t, value) 로 수집.
    핸들러는 Context 의 인과적 접근만 쓸 수 있어 룩어헤드가 불가능하다.
    """
    if not series:
        raise ValueError("no series provided")
    lengths = {len(s) for s in series.values()}
    if len(lengths) != 1:
        raise ValueError(f"series length mismatch: {lengths}")
    n = lengths.pop()

    results: list[tuple[int, object]] = []
    for t in range(n):
        for s in series.values():
            s.seek(t)
        out = on_bar(Context(t, series))
        if out is not None:
            results.append((t, out))
    return results


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    KRW, USD = "KRW", "USD"

    print("=== 1) 차원·통화 타입 ===")
    px = Price(10_000, KRW)
    qty = Shares(50)
    notional = px * qty
    print(f"Price(10,000 KRW) * Shares(50) = Notional({notional.value:,.0f} {notional.currency})")
    print(f"Notional / Price = Shares({(notional / px).value:.0f})")
    try:
        _ = Price(100, KRW) + Price(1, USD)
    except TypeError as e:
        print("통화 혼동 차단:", e)
    print()

    print("=== 2) 인과적 시계열: 미래 접근 차단 ===")
    close = CausalSeries([100, 101, 102, 103, 104], name="close")
    close.seek(2)
    print(f"now={close.now()}  ago(1)={close.ago(1)}  ago(5)={close.ago(5)} (히스토리 이전)")
    print(f"window(3)={close.window(3)}")
    try:
        close.ago(-1)
    except LookAheadError as e:
        print("룩어헤드 차단:", e)
    try:
        _ = close[3]
    except LookAheadError as e:
        print("자유 인덱싱 차단:", e)
    print()

    print("=== 3) 반응형 블록: 모멘텀 시그널 ===")
    closes = CausalSeries([100, 102, 101, 105, 110, 108], name="close")

    def on_bar(ctx: Context):
        c = ctx["close"]
        prev = c.ago(1)
        if prev is None:
            return None
        # 인과적: 현재 바까지의 정보만. 결정은 시뮬레이터가 '다음 바'에 체결.
        if c.now() > prev:
            return "BUY"
        if c.now() < prev:
            return "SELL"
        return None

    signals = run_reactive({"close": closes}, on_bar)
    print("시그널(t, action):", signals)
