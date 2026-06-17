"""
kairos/pit.py
=============
PIT(Point-In-Time) 데이터 레이어 — 발굴 파이프라인 ②단계의 데이터 토대
(CLAUDE.md §4, §8, §10-3).

이 모듈이 막는 것
  - 생존편향(survivorship bias): "지금 상장된 종목"으로 과거를 보면 망한 종목이
    데이터에서 빠져 성과가 부풀려진다. 생존편향은 룩어헤드의 일종(§3).
  - as-of 누수: 그 시점에 *아직 알 수 없던* 정보(미래 공시/수정 데이터)를
    과거 결정에 쓰는 것.
  - 같은 바 누수(same-bar leak): 바 t 에서 만들어진 값(예: 종가 기반 피처)을
    같은 바 t 의 결정/체결에 쓰는 것. 인과적으로는 t+1 부터만 쓸 수 있다.

설계 메모 (라이브 연동 가정 — CLAUDE.md 에 명시)
  - 실제 시세/펀더멘털/상폐 데이터 소스는 아직 미연동. 이 모듈은 인메모리
    인터페이스와 PIT 로직을 먼저 확정한다 (스타일: 자기완결 + __main__ 데모).
  - 상폐는 '전향 수집(forward collection)'이다: 우리가 로깅을 시작한 시점
    (`coverage_start`) 이전의 상폐는 데이터에 없을 수 있으므로, 그 이전 구간의
    유니버스는 생존편향이 남아 있다고 표시한다.
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# 1) PIT 유니버스 (상장/상폐 + 전향 수집)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Listing:
    """한 종목의 상장 생애. 날짜는 거래일(YYYY-MM-DD)."""
    ticker: str
    listed_on: date
    delisted_on: date | None = None          # 실제 시장 상폐일 (None = 아직 거래중)
    delisting_recorded_on: date | None = None  # 우리가 그 상폐를 '로깅한' 날 (전향 수집)


@dataclass
class PITUniverse:
    """
    as-of 기준으로 '그 시점에 실제로 거래되던 종목 집합'을 돌려준다.
    오늘의 유니버스를 과거에 투영하지 않는다 = 생존편향 차단.

    coverage_start: 상폐 전향 수집을 시작한 날. 이 날 이전 구간은 상폐 정보가
                    불완전하므로 unbiased 가 아니라고 본다.
    """
    coverage_start: date | None = None
    _listings: dict[str, Listing] = field(default_factory=dict)

    def add_listing(self, listing: Listing) -> None:
        self._listings[listing.ticker] = listing

    def log_delisting(self, ticker: str, delisted_on: date,
                      recorded_on: date | None = None) -> None:
        """상폐를 전향 수집으로 기록. recorded_on 기본값 = 상폐일."""
        cur = self._listings.get(ticker)
        if cur is None:
            raise KeyError(f"unknown ticker: {ticker}")
        self._listings[ticker] = Listing(
            ticker=cur.ticker,
            listed_on=cur.listed_on,
            delisted_on=delisted_on,
            delisting_recorded_on=recorded_on or delisted_on,
        )

    def as_of(self, asof: date) -> set[str]:
        """asof 날짜에 거래되고 있던 종목 집합 (PIT)."""
        out = set()
        for lst in self._listings.values():
            if lst.listed_on > asof:
                continue                                   # 아직 미상장
            if lst.delisted_on is not None and lst.delisted_on <= asof:
                continue                                   # 이미 상폐됨
            out.add(lst.ticker)
        return out

    def is_unbiased_asof(self, asof: date) -> bool:
        """asof 가 상폐 수집 커버리지 안에 있어 생존편향이 없다고 볼 수 있는가."""
        return self.coverage_start is not None and asof >= self.coverage_start

    def delisted_between(self, start: date, end: date) -> set[str]:
        """[start, end] 구간에 상폐된 종목 — 생존편향 점검/플래그용."""
        return {
            lst.ticker for lst in self._listings.values()
            if lst.delisted_on is not None and start <= lst.delisted_on <= end
        }


# ---------------------------------------------------------------------------
# 2) as-of 조인 (+ 같은 바 누수 방지)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class PITRecord:
    """
    한 시점에 '알려지게 된' 값. effective_at = 그 값을 우리가 쓸 수 있게 된 시각
    (공시 시각/데이터 도착 시각). 발생 시각이 아니라 *지식 가능 시각* 이어야 한다.
    """
    effective_at: Any   # 비교 가능(정렬 가능)하면 됨: date/datetime/int...
    value: Any


def as_of_join(timestamps: Iterable[Any],
               records: Iterable[PITRecord],
               allow_same_timestamp: bool = False) -> list[Any]:
    """
    각 timestamp 에 대해, 그 시점까지 '알 수 있던' 가장 최신 record.value 를 정렬해 반환.

    allow_same_timestamp:
      - False (기본, 인과 안전): effective_at < ts 인 record 만 보임.
        => 같은 바/같은 시각에 도착한 값은 그 시각에는 못 쓰고 '다음'부터 쓸 수 있음
           (same-bar leak 차단).
      - True: effective_at <= ts. 일/저빈도 데이터에서 같은 날 값을 허용할 때만.

    못 찾으면 해당 위치는 None.
    """
    recs = sorted(records, key=lambda r: r.effective_at)
    eff = [r.effective_at for r in recs]
    out = []
    for ts in timestamps:
        if allow_same_timestamp:
            idx = bisect.bisect_right(eff, ts)        # effective_at <= ts
        else:
            idx = bisect.bisect_left(eff, ts)         # effective_at <  ts
        out.append(recs[idx - 1].value if idx > 0 else None)
    return out


def assert_no_same_bar_leak(signal_effective_at: Any, decision_ts: Any) -> None:
    """
    피처가 decision_ts 의 결정에 쓰여도 되는지 검사. 같은 바/미래 정보면 예외.
    (시뮬레이터의 '다음 바 체결'과 짝을 이루는 데이터쪽 가드.)
    """
    if signal_effective_at >= decision_ts:
        raise ValueError(
            f"same-bar/look-ahead leak: signal@{signal_effective_at} "
            f"cannot inform decision@{decision_ts}"
        )


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    d = date

    print("=== 1) 생존편향 차단: as-of 유니버스 ===")
    uni = PITUniverse(coverage_start=d(2020, 1, 1))
    uni.add_listing(Listing("AAA", listed_on=d(2018, 3, 1)))
    uni.add_listing(Listing("BBB", listed_on=d(2019, 6, 1)))
    uni.add_listing(Listing("ZOMBIE", listed_on=d(2017, 1, 1)))
    uni.log_delisting("ZOMBIE", delisted_on=d(2021, 5, 20))
    print("2020-01-02 유니버스:", sorted(uni.as_of(d(2020, 1, 2))))   # ZOMBIE 포함(아직 생존)
    print("2022-01-02 유니버스:", sorted(uni.as_of(d(2022, 1, 2))))   # ZOMBIE 빠짐(상폐)
    print("2019 구간 unbiased? ", uni.is_unbiased_asof(d(2019, 6, 1)))
    print("2021 구간 unbiased? ", uni.is_unbiased_asof(d(2021, 6, 1)))
    print("2021 상폐목록:", sorted(uni.delisted_between(d(2021, 1, 1), d(2021, 12, 31))), "\n")

    print("=== 2) as-of 조인: 공시는 도착한 뒤부터만 보인다 ===")
    earnings = [
        PITRecord(effective_at=d(2021, 2, 15), value="Q4'20"),
        PITRecord(effective_at=d(2021, 5, 14), value="Q1'21"),
    ]
    bars = [d(2021, 2, 14), d(2021, 2, 15), d(2021, 3, 1), d(2021, 5, 20)]
    print("바 날짜      :", [b.isoformat() for b in bars])
    print("strict(<)   :", as_of_join(bars, earnings))                       # 2/15 엔 아직 None
    print("allow(<=)   :", as_of_join(bars, earnings, allow_same_timestamp=True))  # 2/15 부터 보임
    print()

    print("=== 3) same-bar 누수 가드 ===")
    try:
        assert_no_same_bar_leak(d(2021, 3, 1), d(2021, 3, 1))
    except ValueError as e:
        print("차단됨:", e)
