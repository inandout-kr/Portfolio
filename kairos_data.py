"""
kairos/data.py
==============
시세 데이터 어댑터 — 사용자의 기존 백테스트 엔진/시세 데이터를 Kairos 파이프라인
입력으로 변환 (CLAUDE.md §6 데이터 제약, §10-3 라이브 가정).

라이브 가정: 실제 시세 소스(1분~일봉)는 사용자가 공급한다. 이 모듈은 그 데이터를
  - kairos_simulator.Bar 리스트, 그리고
  - kairos_pipeline 이 쓰는 (closes, volumes) 리스트
로 바꿔주는 *얇은 변환 계층*이다. 의존성 없음(csv 표준 라이브러리만).

지원 입력
  - list[dict]   : 각 행에 open/high/low/close/value(+선택 halted/limit_up/down)
  - CSV 파일     : load_csv → list[dict] → bars_from_rows
"""
from __future__ import annotations

import csv
from typing import Iterable

from kairos_simulator import Bar

# 동의어 허용 (사용자 데이터 컬럼명이 제각각일 수 있음)
_VALUE_KEYS = ("value", "거래대금", "amount", "turnover")
_OHLC = {
    "open": ("open", "o", "시가"),
    "high": ("high", "h", "고가"),
    "low": ("low", "l", "저가"),
    "close": ("close", "c", "종가"),
}


def _pick(row: dict, keys: tuple[str, ...], required: bool = True, default=None):
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    if required:
        raise KeyError(f"missing any of {keys} in row keys={list(row)}")
    return default


def _as_float(x) -> float:
    if isinstance(x, str):
        x = x.replace(",", "").strip()
    return float(x)


def _as_bool(x) -> bool:
    if isinstance(x, bool):
        return x
    if isinstance(x, str):
        return x.strip().lower() in ("1", "true", "t", "y", "yes")
    return bool(x)


def bar_from_row(row: dict) -> Bar:
    """한 행(dict)을 Bar 로. value(거래대금)는 필수, halted/limit_*는 선택."""
    o = _as_float(_pick(row, _OHLC["open"]))
    h = _as_float(_pick(row, _OHLC["high"]))
    lo = _as_float(_pick(row, _OHLC["low"]))
    c = _as_float(_pick(row, _OHLC["close"]))
    v = _as_float(_pick(row, _VALUE_KEYS))
    halted = _as_bool(_pick(row, ("halted", "정지"), required=False, default=False))
    lu = _pick(row, ("limit_up",), required=False)
    ld = _pick(row, ("limit_down",), required=False)
    return Bar(
        open=o, high=h, low=lo, close=c, value=v, halted=halted,
        limit_up=_as_float(lu) if lu not in (None, "") else None,
        limit_down=_as_float(ld) if ld not in (None, "") else None,
    )


def bars_from_rows(rows: Iterable[dict]) -> list[Bar]:
    return [bar_from_row(r) for r in rows]


def closes_volumes(rows: Iterable[dict]) -> tuple[list[float], list[float]]:
    """파이프라인용 (closes, volumes). volume 없으면 거래대금(value)으로 대체."""
    closes, volumes = [], []
    for r in rows:
        closes.append(_as_float(_pick(r, _OHLC["close"])))
        vol = _pick(r, ("volume", "거래량", "vol"), required=False)
        volumes.append(_as_float(vol) if vol not in (None, "")
                       else _as_float(_pick(r, _VALUE_KEYS)))
    return closes, volumes


def load_csv(path: str) -> list[dict]:
    """CSV → list[dict] (헤더 필요)."""
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


# ---------------------------------------------------------------------------
# 데모
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rows = [
        {"open": "10000", "high": "10100", "low": "9950", "close": "10050",
         "value": "1,000,000,000", "volume": "100000"},
        {"open": "10050", "high": "10080", "low": "9900", "close": "9920",
         "value": "800,000,000", "halted": "false"},
        {"open": "9920", "high": "9920", "low": "9920", "close": "9920",
         "value": "5,000,000", "limit_down": "9920"},
    ]
    print("=== 행 → Bar 변환 ===")
    for b in bars_from_rows(rows):
        print(f"  O{b.open:.0f} H{b.high:.0f} L{b.low:.0f} C{b.close:.0f} "
              f"value{b.value:,.0f} halted={b.halted} ld={b.limit_down}")

    closes, volumes = closes_volumes(rows)
    print(f"\ncloses ={closes}")
    print(f"volumes={volumes}  (2번째는 거래량 없어 거래대금으로 대체)")
