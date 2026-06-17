"""Kairos 언어 — 렉서 (소스 문자열 → 토큰 리스트)."""
from __future__ import annotations

from .errors import LexError
from .tokens import KEYWORDS, T, Token

_SINGLE = {
    "+": T.PLUS, "-": T.MINUS, "*": T.STAR, "/": T.SLASH, "%": T.PERCENT,
    "(": T.LPAREN, ")": T.RPAREN, "{": T.LBRACE, "}": T.RBRACE,
    ",": T.COMMA, ".": T.DOT, ":": T.COLON, ";": T.SEMI,
}


class Lexer:
    def __init__(self, src: str):
        self.src = src
        self.i = 0
        self.line = 1
        self.tokens: list[Token] = []

    def _peek(self, k: int = 0) -> str:
        j = self.i + k
        return self.src[j] if j < len(self.src) else "\0"

    def _advance(self) -> str:
        c = self.src[self.i]
        self.i += 1
        if c == "\n":
            self.line += 1
        return c

    def _match(self, expected: str) -> bool:
        if self._peek() == expected:
            self.i += 1
            return True
        return False

    def tokenize(self) -> list[Token]:
        while self.i < len(self.src):
            self._scan()
        self.tokens.append(Token(T.EOF, "", self.line))
        return self.tokens

    def _add(self, type: T, lexeme: str, value=None):
        self.tokens.append(Token(type, lexeme, self.line, value))

    def _scan(self):
        c = self._advance()
        if c in " \t\r\n":
            return
        if c == "#":                       # 주석: 줄 끝까지
            while self._peek() not in ("\n", "\0"):
                self._advance()
            return
        if c == '"':
            return self._string()
        if c.isdigit():
            return self._number(c)
        if c.isalpha() or c == "_":
            return self._ident(c)
        # 2글자 연산자
        if c == "=":
            if self._match("="):
                return self._add(T.EQEQ, "==")
            return self._add(T.EQ, "=")
        if c == "!":
            if self._match("="):
                return self._add(T.BANGEQ, "!=")
            raise LexError("unexpected '!'", self.line)
        if c == "<":
            return self._add(T.LE, "<=") if self._match("=") else self._add(T.LT, "<")
        if c == ">":
            return self._add(T.GE, ">=") if self._match("=") else self._add(T.GT, ">")
        if c in _SINGLE:
            return self._add(_SINGLE[c], c)
        raise LexError(f"unexpected character {c!r}", self.line)

    def _string(self):
        start_line = self.line
        chars = []
        while self._peek() not in ('"', "\0"):
            chars.append(self._advance())
        if self._peek() == "\0":
            raise LexError("unterminated string", start_line)
        self._advance()                    # 닫는 "
        s = "".join(chars)
        self._add(T.STRING, f'"{s}"', s)

    def _number(self, first: str):
        digits = [first]
        is_float = False
        while self._peek().isdigit() or self._peek() == "_":
            ch = self._advance()
            if ch != "_":
                digits.append(ch)
        if self._peek() == "." and self._peek(1).isdigit():
            is_float = True
            digits.append(self._advance())  # .
            while self._peek().isdigit() or self._peek() == "_":
                ch = self._advance()
                if ch != "_":
                    digits.append(ch)
        text = "".join(digits)
        value = float(text) if is_float else int(text)
        self._add(T.NUMBER, text, value)

    def _ident(self, first: str):
        chars = [first]
        while self._peek().isalnum() or self._peek() == "_":
            chars.append(self._advance())
        name = "".join(chars)
        type = KEYWORDS.get(name, T.IDENT)
        value = name if type == T.CURRENCY else None
        self._add(type, name, value)


def tokenize(src: str) -> list[Token]:
    return Lexer(src).tokenize()
