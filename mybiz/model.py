"""
mybiz/model.py
==============
장부의 핵심 타입 — 계정 유형, 원본 거래(RawTxn), 분개(JournalEntry).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date
from enum import Enum


class AccountType(Enum):
    ASSET = "자산"
    LIABILITY = "부채"
    EQUITY = "자본"
    REVENUE = "수익"
    EXPENSE = "비용"


# 대변(credit) 정상잔액 계정 — 보고서에서 부호를 뒤집어 양수로 보여준다.
CREDIT_NORMAL = {AccountType.LIABILITY, AccountType.EQUITY, AccountType.REVENUE}

UNCATEGORIZED_IN = "수익:미분류"
UNCATEGORIZED_OUT = "비용:미분류"
OPENING_EQUITY = "자본:기초순자산"


def account_type(account: str) -> AccountType:
    """계정 경로의 첫 마디로 유형 판정. 모르는 접두어는 예외."""
    head = account.split(":", 1)[0]
    for t in AccountType:
        if t.value == head:
            return t
    raise ValueError(f"계정은 자산/부채/자본/수익/비용 중 하나로 시작해야 함: {account!r}")


def is_own(account: str) -> bool:
    """내 소유 계정(자산/부채) — 이 계정끼리 오가는 돈은 손익이 아니다."""
    return account_type(account) in (AccountType.ASSET, AccountType.LIABILITY)


@dataclass(frozen=True)
class RawTxn:
    """원본 거래 1건. amount 는 source 계정 기준 부호(+ 유입, − 유출)."""

    date: date
    amount: int
    description: str
    source: str  # 거래가 발생한 내 계정 (예: "자산:통장:국민", "부채:카드:신한")
    seq: int = 0  # 같은 날·같은 금액·같은 적요가 여러 건일 때 구분자

    def __post_init__(self):
        if not is_own(self.source):
            raise ValueError(f"source 는 자산/부채 계정이어야 함: {self.source!r}")

    @property
    def id(self) -> str:
        """내용 기반 결정적 ID — 겹치는 기간을 다시 가져와도 중복 저장되지 않는다."""
        key = f"{self.source}|{self.date.isoformat()}|{self.amount}|{self.description}|{self.seq}"
        return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


@dataclass(frozen=True)
class Posting:
    account: str
    amount: int  # 차변 +, 대변 −


@dataclass
class JournalEntry:
    date: date
    memo: str
    postings: list[Posting]
    txn_ids: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self):
        for p in self.postings:
            account_type(p.account)  # 계정명 검증
        total = sum(p.amount for p in self.postings)
        if total != 0:
            raise ValueError(f"대차 불일치 {total:+,}원: {self.memo!r}")
