"""
mybiz/importers.py
==================
거래내역 가져오기 — 은행/카드사/마이데이터 앱(뱅크샐러드 등) 내보내기 CSV, 또는
API 가 준 행(dict) 목록을 RawTxn 으로 변환.

마이데이터 API 는 금융위 허가 사업자만 직접 호출할 수 있어서, 개인은
  (1) 마이데이터 앱의 '엑셀/CSV 내보내기', (2) 은행·카드사 거래내역 다운로드,
  (3) 스크래핑형 API(CODEF 등) — rows_to_txns 에 행만 넘기면 됨
중 하나로 데이터를 받는다. 이 모듈은 어느 쪽이든 같은 RawTxn 으로 정규화한다.

컬럼명은 제각각이라 동의어로 찾고, 헤더 위 안내문(계좌번호·조회기간 등)은 건너뛴다.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date
from typing import Iterable

from .model import AccountType, RawTxn, account_type

_DATE = ("날짜", "일자", "거래일", "거래일자", "거래일시", "이용일", "이용일자", "이용일시",
         "승인일", "승인일자", "승인일시", "date")
_AMOUNT = ("금액", "거래금액", "이용금액", "승인금액", "amount")
_OUT = ("출금", "출금액", "출금금액", "찾으신금액", "지급금액")
_IN = ("입금", "입금액", "입금금액", "맡기신금액")
_DESC = ("내용", "적요", "거래내용", "가맹점", "가맹점명", "이용가맹점", "이용하신곳",
         "기재내용", "받는분/보낸분", "대분류", "소분류", "메모", "description")
_KIND = ("타입", "구분", "입출금구분", "type")  # 뱅크샐러드: 수입/지출/이체

_DATE_RE = re.compile(r"(\d{4})\s*[.\-/년]?\s*(\d{1,2})\s*[.\-/월]?\s*(\d{1,2})")


def _norm(h: str) -> str:
    return re.sub(r"[\s()]|\(원\)", "", (h or "").strip().lower())


def parse_date(s: str) -> date:
    m = _DATE_RE.search(str(s))
    if not m:
        raise ValueError(f"날짜 해석 불가: {s!r}")
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def parse_amount(s) -> int:
    """'1,234원' / '-5,000' / '(5,000)' / '' → 정수. 빈칸은 0."""
    if isinstance(s, (int, float)):
        return int(round(s))
    t = str(s or "").strip().replace(",", "").replace("원", "").replace(" ", "")
    if not t or t == "-":
        return 0
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()")
    v = int(round(float(t)))
    return -v if neg else v


def _find(headers: list[str], names: tuple[str, ...]) -> list[str]:
    wanted = {_norm(n) for n in names}
    return [h for h in headers if _norm(h) in wanted]


def rows_to_txns(rows: Iterable[dict], source: str) -> list[RawTxn]:
    """행(dict) 목록 → RawTxn. 부호는 source 계정 기준(+유입/−유출)으로 맞춘다.

    - 입금/출금 두 칸 → 입금 − 출금
    - 금액 한 칸 + 타입(수입/지출) → 타입으로 부호
    - 금액 한 칸, source 가 부채(카드) → 양수는 사용(−), 음수는 취소(+)
    - 금액 한 칸, 그 외 → 값의 부호 그대로
    """
    rows = list(rows)
    if not rows:
        return []
    is_card = account_type(source) is AccountType.LIABILITY
    headers = list(rows[0].keys())
    date_col = _find(headers, _DATE)
    if not date_col:
        raise KeyError(f"날짜 컬럼을 못 찾음: {headers}")
    amt_col, out_col, in_col = _find(headers, _AMOUNT), _find(headers, _OUT), _find(headers, _IN)
    desc_cols, kind_col = _find(headers, _DESC), _find(headers, _KIND)
    if not (amt_col or out_col or in_col):
        raise KeyError(f"금액/입금/출금 컬럼을 못 찾음: {headers}")

    out: list[RawTxn] = []
    seen: dict[tuple, int] = {}
    for row in rows:
        raw_date = row.get(date_col[0])
        if not raw_date or not _DATE_RE.search(str(raw_date)):
            continue  # 합계행·빈행
        d = parse_date(raw_date)
        if out_col or in_col:
            amount = (parse_amount(row.get(in_col[0])) if in_col else 0) - (
                parse_amount(row.get(out_col[0])) if out_col else 0)
        else:
            amount = parse_amount(row.get(amt_col[0]))
            kind = str(row.get(kind_col[0], "")).strip() if kind_col else ""
            if kind in ("지출", "출금"):
                amount = -abs(amount)
            elif kind in ("수입", "입금"):
                amount = abs(amount)
            elif is_card:
                amount = -amount
        if amount == 0:
            continue
        desc = " ".join(str(row.get(c, "")).strip() for c in desc_cols if row.get(c)).strip()
        key = (d, amount, desc)
        seq = seen.get(key, 0)
        seen[key] = seq + 1
        out.append(RawTxn(date=d, amount=amount, description=desc, source=source, seq=seq))
    return out


def read_csv_rows(text: str) -> list[dict]:
    """CSV 텍스트 → dict 행. 헤더 위 안내문은 날짜+금액 컬럼이 나올 때까지 건너뛴다."""
    lines = list(csv.reader(io.StringIO(text)))
    date_names = {_norm(n) for n in _DATE}
    money_names = {_norm(n) for n in _AMOUNT + _OUT + _IN}
    for i, line in enumerate(lines):
        cells = {_norm(c) for c in line}
        if cells & date_names and cells & money_names:
            header = [c.strip() for c in line]
            return [dict(zip(header, r)) for r in lines[i + 1:] if any(x.strip() for x in r)]
    raise KeyError("헤더 행(날짜+금액)을 찾지 못함")


def load_csv(path: str, source: str) -> list[RawTxn]:
    """CSV 파일 로드. 국내 은행 파일은 CP949 가 많아 UTF-8 실패 시 CP949 로 재시도."""
    with open(path, "rb") as f:
        data = f.read()
    for enc in ("utf-8-sig", "cp949"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise UnicodeDecodeError("utf-8/cp949", data[:0], 0, 0, f"인코딩 판별 실패: {path}")
    return rows_to_txns(read_csv_rows(text), source)
