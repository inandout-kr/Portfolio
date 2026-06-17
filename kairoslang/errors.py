"""Kairos 언어 — 에러 타입."""
from __future__ import annotations


class KairosError(Exception):
    """모든 Kairos 언어 에러의 베이스. line 정보를 담는다."""
    def __init__(self, message: str, line: int | None = None):
        self.message = message
        self.line = line
        loc = f" (line {line})" if line else ""
        super().__init__(f"{message}{loc}")


class LexError(KairosError):
    """렉싱 단계 에러."""


class ParseError(KairosError):
    """파싱 단계 에러."""


class KairosTypeError(KairosError):
    """차원·통화 타입 위반 등 타입 에러 (예: Price<KRW> + Price<USD>)."""


class RuntimeErr(KairosError):
    """실행 단계 에러 (미정의 변수, 0으로 나눔 등)."""


class LookAheadError(KairosError):
    """미래 데이터 접근 — 시간 안전성 위반 (chronos/kairos 혼동)."""
