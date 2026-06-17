"""PIT 데이터 레이어 테스트."""
from datetime import date

import pytest

from kairos_pit import (
    Listing,
    PITRecord,
    PITUniverse,
    as_of_join,
    assert_no_same_bar_leak,
)


def make_universe():
    uni = PITUniverse(coverage_start=date(2020, 1, 1))
    uni.add_listing(Listing("AAA", listed_on=date(2018, 3, 1)))
    uni.add_listing(Listing("BBB", listed_on=date(2019, 6, 1)))
    uni.add_listing(Listing("ZOMBIE", listed_on=date(2017, 1, 1)))
    uni.log_delisting("ZOMBIE", delisted_on=date(2021, 5, 20))
    return uni


# --- 유니버스 / 생존편향 -----------------------------------------------------
def test_unlisted_ticker_absent_before_listing():
    uni = make_universe()
    assert "BBB" not in uni.as_of(date(2019, 1, 1))
    assert "BBB" in uni.as_of(date(2019, 6, 1))


def test_delisted_ticker_present_before_then_gone_after():
    uni = make_universe()
    assert "ZOMBIE" in uni.as_of(date(2020, 1, 2))   # 아직 생존
    assert "ZOMBIE" not in uni.as_of(date(2022, 1, 2))  # 상폐 후


def test_delisting_day_excluded():
    uni = make_universe()
    # 상폐일 당일은 더 이상 거래 가능 유니버스에 없음.
    assert "ZOMBIE" not in uni.as_of(date(2021, 5, 20))
    assert "ZOMBIE" in uni.as_of(date(2021, 5, 19))


def test_unbiased_window_respects_coverage_start():
    uni = make_universe()
    assert not uni.is_unbiased_asof(date(2019, 12, 31))
    assert uni.is_unbiased_asof(date(2020, 1, 1))


def test_delisted_between():
    uni = make_universe()
    assert uni.delisted_between(date(2021, 1, 1), date(2021, 12, 31)) == {"ZOMBIE"}
    assert uni.delisted_between(date(2020, 1, 1), date(2020, 12, 31)) == set()


def test_log_delisting_unknown_ticker_raises():
    uni = make_universe()
    with pytest.raises(KeyError):
        uni.log_delisting("NOPE", delisted_on=date(2021, 1, 1))


# --- as-of 조인 --------------------------------------------------------------
def test_as_of_join_strict_blocks_same_timestamp():
    recs = [PITRecord(date(2021, 2, 15), "Q4")]
    # strict: 2/15 당일엔 아직 안 보임 (same-bar leak 차단)
    assert as_of_join([date(2021, 2, 15)], recs) == [None]
    # 다음 날부터 보임
    assert as_of_join([date(2021, 2, 16)], recs) == ["Q4"]


def test_as_of_join_allow_same_timestamp():
    recs = [PITRecord(date(2021, 2, 15), "Q4")]
    assert as_of_join([date(2021, 2, 15)], recs, allow_same_timestamp=True) == ["Q4"]


def test_as_of_join_picks_latest_available():
    recs = [
        PITRecord(date(2021, 2, 15), "Q4"),
        PITRecord(date(2021, 5, 14), "Q1"),
    ]
    out = as_of_join([date(2021, 3, 1), date(2021, 5, 20)], recs)
    assert out == ["Q4", "Q1"]


def test_as_of_join_none_before_any_record():
    recs = [PITRecord(date(2021, 2, 15), "Q4")]
    assert as_of_join([date(2021, 1, 1)], recs) == [None]


def test_as_of_join_unsorted_records_ok():
    recs = [
        PITRecord(3, "c"),
        PITRecord(1, "a"),
        PITRecord(2, "b"),
    ]
    # 정수 타임스탬프도 동작, 입력 순서 무관
    assert as_of_join([2, 4], recs) == ["a", "c"]


# --- same-bar 누수 가드 ------------------------------------------------------
def test_assert_no_same_bar_leak_raises_on_same_ts():
    with pytest.raises(ValueError):
        assert_no_same_bar_leak(date(2021, 3, 1), date(2021, 3, 1))


def test_assert_no_same_bar_leak_raises_on_future():
    with pytest.raises(ValueError):
        assert_no_same_bar_leak(date(2021, 3, 2), date(2021, 3, 1))


def test_assert_no_same_bar_leak_ok_on_past():
    # 과거 정보는 통과 (예외 없음)
    assert_no_same_bar_leak(date(2021, 2, 28), date(2021, 3, 1))
