"""Kairos 언어 — 토큰 정의."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto


class T(Enum):
    # 리터럴
    NUMBER = auto()
    STRING = auto()
    IDENT = auto()
    CURRENCY = auto()       # KRW, USD  (Price 리터럴 접두)
    UNIT_SHARES = auto()    # shares, sh (Shares 리터럴 접미)
    # 키워드
    LET = auto()
    FN = auto()
    RETURN = auto()
    IF = auto()
    ELSE = auto()
    WHILE = auto()
    TRUE = auto()
    FALSE = auto()
    PRINT = auto()
    AND = auto()
    OR = auto()
    NOT = auto()
    NIL = auto()
    # 기호
    PLUS = auto()
    MINUS = auto()
    STAR = auto()
    SLASH = auto()
    PERCENT = auto()
    EQ = auto()             # =
    EQEQ = auto()           # ==
    BANGEQ = auto()         # !=
    LT = auto()
    GT = auto()
    LE = auto()
    GE = auto()
    LPAREN = auto()
    RPAREN = auto()
    LBRACE = auto()
    RBRACE = auto()
    COMMA = auto()
    DOT = auto()
    COLON = auto()
    SEMI = auto()
    EOF = auto()


KEYWORDS = {
    "let": T.LET, "fn": T.FN, "return": T.RETURN, "if": T.IF, "else": T.ELSE,
    "while": T.WHILE, "true": T.TRUE, "false": T.FALSE, "print": T.PRINT,
    "and": T.AND, "or": T.OR, "not": T.NOT, "nil": T.NIL,
    "KRW": T.CURRENCY, "USD": T.CURRENCY,
    "shares": T.UNIT_SHARES, "sh": T.UNIT_SHARES,
}


@dataclass
class Token:
    type: T
    lexeme: str
    line: int
    value: object = None   # NUMBER→int/float, STRING→str, CURRENCY→"KRW"

    def __repr__(self) -> str:
        return f"Token({self.type.name}, {self.lexeme!r}, L{self.line})"
