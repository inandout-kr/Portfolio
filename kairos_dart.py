"""
kairos/dart.py
==============
DART 상폐 수집기 — 상장폐지를 '전향 수집'해 PIT 유니버스에 흘려보낸다
(CLAUDE.md §8 생존편향 4중 방어-3, §10-3 라이브 가정).

설계
  - 수집은 fetch_fn 주입식: 실제 DART(opendart.fss.or.kr) HTTP 호출이든,
    파일이든, 테스트용 가짜든 같은 인터페이스. → 네트워크/키 없이 테스트 가능.
  - fetch_fn() 은 raw 레코드(dict) 리스트를 돌려준다. 각 dict 에서
    종목코드/상폐일을 뽑아 DelistingRecord 로 정규화 → PITUniverse.log_delisting.
  - 실제 DART 클라이언트(DartClient)는 API 키(DART_API_KEY)와 네트워크가 있을 때만
    동작. 키/네트워크 없는 환경에선 import 만 되고, 호출 시 명확히 실패.

라이브 가정: 진짜 DART 키/엔드포인트 연동은 사용자 환경에서. 여기선 수집 로직과
정규화/적용을 확정한다.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, datetime
from typing import Callable, Iterable

from kairos_pit import PITUniverse

# DART 원본 필드 동의어
_TICKER_KEYS = ("stock_code", "ticker", "종목코드", "corp_code")
_DELIST_KEYS = ("delisting_date", "delisted_on", "상장폐지일", "list_dt", "date")


@dataclass(frozen=True)
class DelistingRecord:
    ticker: str
    delisted_on: date
    recorded_on: date | None = None   # 우리가 수집(로깅)한 날 = 전향 수집 시점


def _parse_date(x) -> date:
    if isinstance(x, date):
        return x
    s = str(x).strip().replace(".", "-").replace("/", "-")
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(s if fmt != "%Y%m%d" else s.replace("-", ""), fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unparsable date: {x!r}")


def _pick(row: dict, keys: tuple[str, ...]):
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    raise KeyError(f"missing any of {keys} in {list(row)}")


def normalize(raw: Iterable[dict], recorded_on: date | None = None) -> list[DelistingRecord]:
    """DART raw 레코드 → DelistingRecord. recorded_on 기본값 = 오늘(전향 수집)."""
    rec_on = recorded_on or date.today()
    out = []
    for row in raw:
        out.append(DelistingRecord(
            ticker=str(_pick(row, _TICKER_KEYS)).strip().zfill(6),
            delisted_on=_parse_date(_pick(row, _DELIST_KEYS)),
            recorded_on=rec_on,
        ))
    return out


def collect_delistings(fetch_fn: Callable[[], Iterable[dict]],
                       recorded_on: date | None = None) -> list[DelistingRecord]:
    """fetch_fn 으로 raw 를 받아 정규화. fetch_fn 이 소스 추상화(HTTP/파일/가짜)."""
    return normalize(fetch_fn(), recorded_on=recorded_on)


def apply_to_universe(universe: PITUniverse,
                      records: Iterable[DelistingRecord],
                      skip_unknown: bool = True) -> int:
    """수집한 상폐를 유니버스에 기록. 적용된 건수 반환."""
    applied = 0
    for r in records:
        try:
            universe.log_delisting(r.ticker, r.delisted_on, recorded_on=r.recorded_on)
            applied += 1
        except KeyError:
            if not skip_unknown:
                raise
            # 유니버스에 없는(추적 안 하던) 종목은 건너뜀
    return applied


# ---------------------------------------------------------------------------
# 실제 DART 클라이언트 (키/네트워크 필요 — 그 외 환경에선 호출 시 실패)
# ---------------------------------------------------------------------------
class DartClient:
    """
    opendart 상장폐지 조회용 최소 클라이언트. fetch_fn 으로 collect_delistings 에
    넘겨 쓴다. 실제 엔드포인트/파라미터는 사용자 환경 확정 시 채운다(라이브 가정).
    """
    BASE = "https://opendart.fss.or.kr/api"

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ.get("DART_API_KEY")
        if not self.api_key:
            raise RuntimeError("DART_API_KEY 미설정 — 실제 수집엔 키가 필요하다")

    def fetch_delistings(self) -> list[dict]:  # pragma: no cover - 네트워크 필요
        import json
        from urllib.request import urlopen
        url = f"{self.BASE}/delisting.json?crtfc_key={self.api_key}"
        with urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("list", [])


# ---------------------------------------------------------------------------
# 데모 (가짜 fetch_fn — 네트워크/키 불필요)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uni = PITUniverse(coverage_start=date(2026, 1, 1))
    from kairos_pit import Listing
    uni.add_listing(Listing("000660", listed_on=date(2015, 1, 1)))
    uni.add_listing(Listing("123456", listed_on=date(2019, 1, 1)))

    def fake_fetch():
        return [
            {"stock_code": "123456", "상장폐지일": "2026.05.20"},
            {"stock_code": "999999", "delisting_date": "20260601"},  # 추적 안 하던 종목
        ]

    print("=== DART 상폐 전향 수집 → 유니버스 적용 ===")
    records = collect_delistings(fake_fetch, recorded_on=date(2026, 6, 17))
    for r in records:
        print(f"  {r.ticker} 상폐 {r.delisted_on} (수집 {r.recorded_on})")
    n = apply_to_universe(uni, records)
    print(f"적용 {n}건 (추적 안 하던 999999는 스킵)")
    print(f"2026-06 유니버스: {sorted(uni.as_of(date(2026, 6, 30)))}  (123456 빠짐)")
