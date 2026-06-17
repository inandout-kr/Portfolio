"""Kairos 언어 — CLI. `python3 -m kairoslang run file.ka`"""
from __future__ import annotations

import sys

from .errors import KairosError
from .interpreter import Interpreter
from .lexer import tokenize
from .parser import parse


USAGE = "사용법: kairos run <file.ka>  |  kairos eval '<source>'"


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        print(USAGE, file=sys.stderr)
        return 64

    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "run":
            if not rest:
                print(USAGE, file=sys.stderr)
                return 64
            with open(rest[0], encoding="utf-8") as f:
                src = f.read()
        elif cmd == "eval":
            if not rest:
                print(USAGE, file=sys.stderr)
                return 64
            src = rest[0]
        else:
            print(USAGE, file=sys.stderr)
            return 64

        program = parse(tokenize(src))
        Interpreter().run(program)
        return 0
    except KairosError as e:
        print(f"[Kairos 에러] {e}", file=sys.stderr)
        return 65
    except FileNotFoundError:
        print(f"파일 없음: {rest[0]}", file=sys.stderr)
        return 66


if __name__ == "__main__":
    sys.exit(main())
