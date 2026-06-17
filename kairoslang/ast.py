"""Kairos 언어 — AST 노드 (파서 산출, 인터프리터 입력)."""
from __future__ import annotations

from dataclasses import dataclass, field


class Node:
    line: int = 0


# ---- 표현식 ----------------------------------------------------------------
@dataclass
class NumberLit(Node):
    value: object          # int | float
    line: int = 0


@dataclass
class StringLit(Node):
    value: str
    line: int = 0


@dataclass
class BoolLit(Node):
    value: bool
    line: int = 0


@dataclass
class NilLit(Node):
    line: int = 0


@dataclass
class PriceLit(Node):
    amount: object         # int | float
    currency: str          # "KRW"
    line: int = 0


@dataclass
class SharesLit(Node):
    amount: object
    line: int = 0


@dataclass
class Var(Node):
    name: str
    line: int = 0


@dataclass
class Assign(Node):
    name: str
    value: Node
    line: int = 0


@dataclass
class Unary(Node):
    op: str                # "-" | "not"
    operand: Node
    line: int = 0


@dataclass
class Binary(Node):
    op: str
    left: Node
    right: Node
    line: int = 0


@dataclass
class Logical(Node):
    op: str                # "and" | "or"
    left: Node
    right: Node
    line: int = 0


@dataclass
class Call(Node):
    callee: Node
    args: list = field(default_factory=list)
    line: int = 0


@dataclass
class Get(Node):
    obj: Node
    name: str
    line: int = 0


# ---- 문 --------------------------------------------------------------------
@dataclass
class LetStmt(Node):
    name: str
    type_ann: str | None
    value: Node
    line: int = 0


@dataclass
class ExprStmt(Node):
    expr: Node
    line: int = 0


@dataclass
class PrintStmt(Node):
    expr: Node
    line: int = 0


@dataclass
class Block(Node):
    statements: list = field(default_factory=list)
    line: int = 0


@dataclass
class IfStmt(Node):
    condition: Node
    then_branch: Node      # Block
    else_branch: Node | None  # Block | IfStmt | None
    line: int = 0


@dataclass
class WhileStmt(Node):
    condition: Node
    body: Node
    line: int = 0


@dataclass
class FnDecl(Node):
    name: str
    params: list           # list[str]
    body: Block
    line: int = 0


@dataclass
class ReturnStmt(Node):
    value: Node | None
    line: int = 0


@dataclass
class Program(Node):
    statements: list = field(default_factory=list)
    line: int = 0
