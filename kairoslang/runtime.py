"""
Kairos 언어 — 런타임 값과 차원·통화 타입.

알고리즘 트레이딩 특화의 첫 기둥(§5): 단위 혼동을 *언어 차원*에서 차단한다.
  Price<KRW> * Shares      -> Notional<KRW>
  Notional<KRW> / Price<KRW> -> Shares
  Price<KRW> + Price<USD>   -> 타입 에러
원시값(Int/Float/Bool/Str/nil)은 파이썬 값으로 그대로 표현한다.
"""
from __future__ import annotations

from .errors import KairosTypeError


class Price:
    """가격. 통화 태그를 가진다."""
    __slots__ = ("amount", "currency")

    def __init__(self, amount: float, currency: str):
        self.amount = amount
        self.currency = currency

    def _same(self, other: "Price"):
        if self.currency != other.currency:
            raise KairosTypeError(
                f"통화 불일치: Price<{self.currency}> vs Price<{other.currency}>")

    def __add__(self, other):
        if isinstance(other, Price):
            self._same(other)
            return Price(self.amount + other.amount, self.currency)
        raise KairosTypeError(f"Price + {_tname(other)} 정의 안 됨")

    def __sub__(self, other):
        if isinstance(other, Price):
            self._same(other)
            return Price(self.amount - other.amount, self.currency)
        raise KairosTypeError(f"Price - {_tname(other)} 정의 안 됨")

    def __mul__(self, other):
        if isinstance(other, Shares):
            return Notional(self.amount * other.amount, self.currency)
        if isinstance(other, (int, float)) and not isinstance(other, bool):
            return Price(self.amount * other, self.currency)
        raise KairosTypeError(f"Price * {_tname(other)} 정의 안 됨")

    __rmul__ = __mul__

    def __truediv__(self, other):
        if isinstance(other, Price):
            self._same(other)
            return self.amount / other.amount          # Price/Price = 비율(float)
        if isinstance(other, (int, float)) and not isinstance(other, bool):
            return Price(self.amount / other, self.currency)
        raise KairosTypeError(f"Price / {_tname(other)} 정의 안 됨")

    def __eq__(self, other):
        return isinstance(other, Price) and self.currency == other.currency \
            and self.amount == other.amount

    def _cmp(self, other):
        if not isinstance(other, Price):
            raise KairosTypeError(f"Price 와 {_tname(other)} 비교 불가")
        self._same(other)
    def __lt__(self, o): self._cmp(o); return self.amount < o.amount
    def __le__(self, o): self._cmp(o); return self.amount <= o.amount
    def __gt__(self, o): self._cmp(o); return self.amount > o.amount
    def __ge__(self, o): self._cmp(o); return self.amount >= o.amount

    def __hash__(self): return hash((Price, self.amount, self.currency))
    def __repr__(self): return f"{_num(self.amount)} {self.currency}"


class Shares:
    """수량 (무차원 정수/실수, 단위는 'shares')."""
    __slots__ = ("amount",)

    def __init__(self, amount: float):
        self.amount = amount

    def __add__(self, other):
        if isinstance(other, Shares):
            return Shares(self.amount + other.amount)
        raise KairosTypeError(f"Shares + {_tname(other)} 정의 안 됨")

    def __sub__(self, other):
        if isinstance(other, Shares):
            return Shares(self.amount - other.amount)
        raise KairosTypeError(f"Shares - {_tname(other)} 정의 안 됨")

    def __mul__(self, other):
        if isinstance(other, Price):
            return Notional(self.amount * other.amount, other.currency)
        if isinstance(other, (int, float)) and not isinstance(other, bool):
            return Shares(self.amount * other)
        raise KairosTypeError(f"Shares * {_tname(other)} 정의 안 됨")

    __rmul__ = __mul__

    def __eq__(self, other):
        return isinstance(other, Shares) and self.amount == other.amount

    def _cmp(self, other):
        if not isinstance(other, Shares):
            raise KairosTypeError(f"Shares 와 {_tname(other)} 비교 불가")
    def __lt__(self, o): self._cmp(o); return self.amount < o.amount
    def __le__(self, o): self._cmp(o); return self.amount <= o.amount
    def __gt__(self, o): self._cmp(o); return self.amount > o.amount
    def __ge__(self, o): self._cmp(o); return self.amount >= o.amount

    def __hash__(self): return hash((Shares, self.amount))
    def __repr__(self): return f"{_num(self.amount)} shares"


class Notional:
    """금액 (Price*Shares 의 결과). 통화 태그를 가진다."""
    __slots__ = ("amount", "currency")

    def __init__(self, amount: float, currency: str):
        self.amount = amount
        self.currency = currency

    def _same(self, other):
        if self.currency != other.currency:
            raise KairosTypeError(
                f"통화 불일치: Notional<{self.currency}> vs <{other.currency}>")

    def __add__(self, other):
        if isinstance(other, Notional):
            self._same(other)
            return Notional(self.amount + other.amount, self.currency)
        raise KairosTypeError(f"Notional + {_tname(other)} 정의 안 됨")

    def __sub__(self, other):
        if isinstance(other, Notional):
            self._same(other)
            return Notional(self.amount - other.amount, self.currency)
        raise KairosTypeError(f"Notional - {_tname(other)} 정의 안 됨")

    def __truediv__(self, other):
        if isinstance(other, Price):
            self._same(other)
            return Shares(self.amount / other.amount)      # 금액/가격 = 수량
        if isinstance(other, Shares):
            return Price(self.amount / other.amount, self.currency)  # 금액/수량 = 가격
        if isinstance(other, Notional):
            self._same(other)
            return self.amount / other.amount          # Notional/Notional = 비율(float)
        if isinstance(other, (int, float)) and not isinstance(other, bool):
            return Notional(self.amount / other, self.currency)
        raise KairosTypeError(f"Notional / {_tname(other)} 정의 안 됨")

    def __mul__(self, other):
        if isinstance(other, (int, float)) and not isinstance(other, bool):
            return Notional(self.amount * other, self.currency)
        raise KairosTypeError(f"Notional * {_tname(other)} 정의 안 됨")

    __rmul__ = __mul__

    def __eq__(self, other):
        return isinstance(other, Notional) and self.currency == other.currency \
            and self.amount == other.amount

    def _cmp(self, other):
        if not isinstance(other, Notional):
            raise KairosTypeError(f"Notional 와 {_tname(other)} 비교 불가")
        self._same(other)
    def __lt__(self, o): self._cmp(o); return self.amount < o.amount
    def __le__(self, o): self._cmp(o); return self.amount <= o.amount
    def __gt__(self, o): self._cmp(o); return self.amount > o.amount
    def __ge__(self, o): self._cmp(o); return self.amount >= o.amount

    def __hash__(self): return hash((Notional, self.amount, self.currency))
    def __repr__(self): return f"{_num(self.amount)} {self.currency} (notional)"


def _num(x) -> str:
    if isinstance(x, float) and x.is_integer():
        return f"{int(x):,}"
    if isinstance(x, int):
        return f"{x:,}"
    return f"{x:,}"


def _tname(v) -> str:
    return type(v).__name__


def stringify(v) -> str:
    """Kairos 값의 사람용 표현 (print 용)."""
    if v is None:
        return "nil"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)
