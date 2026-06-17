"""
Kairos — 알고리즘 트레이딩에 특화된 프로그래밍 언어.

자체 문법(.ka) → 렉서 → 파서 → AST → 트리워킹 인터프리터.
첫 기둥(차원·통화 타입)이 언어 차원에서 동작한다.

    from kairoslang import run_source
    run_source('print KRW 10000 * 50 shares')   # -> 500,000 KRW (notional)
"""
from __future__ import annotations

from .interpreter import Interpreter
from .lexer import tokenize
from .parser import parse

__version__ = "0.1.0"


def run_source(src: str) -> list[str]:
    """소스 문자열을 실행하고 print 출력 리스트를 반환."""
    program = parse(tokenize(src))
    return Interpreter().run(program)


def run_file(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return run_source(f.read())
