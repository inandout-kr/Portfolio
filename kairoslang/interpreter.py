"""Kairos 언어 — 트리워킹 인터프리터."""
from __future__ import annotations

from . import ast
from .errors import KairosTypeError, RuntimeErr
from .runtime import Notional, Price, Shares, stringify


class Environment:
    """변수 스코프 (체인)."""
    def __init__(self, parent: "Environment | None" = None):
        self.vars: dict[str, object] = {}
        self.parent = parent

    def define(self, name: str, value):
        self.vars[name] = value

    def get(self, name: str, line: int):
        env = self
        while env is not None:
            if name in env.vars:
                return env.vars[name]
            env = env.parent
        raise RuntimeErr(f"미정의 변수 '{name}'", line)

    def assign(self, name: str, value, line: int):
        env = self
        while env is not None:
            if name in env.vars:
                env.vars[name] = value
                return
            env = env.parent
        raise RuntimeErr(f"미정의 변수 '{name}' 에 대입", line)


class KairosFunction:
    def __init__(self, decl: ast.FnDecl, closure: Environment):
        self.decl = decl
        self.closure = closure

    def call(self, interp: "Interpreter", args: list):
        if len(args) != len(self.decl.params):
            raise RuntimeErr(
                f"'{self.decl.name}'은(는) 인자 {len(self.decl.params)}개를 받지만 "
                f"{len(args)}개가 주어짐", self.decl.line)
        env = Environment(self.closure)
        for p, a in zip(self.decl.params, args):
            env.define(p, a)
        try:
            interp._exec_block(self.decl.body, env)
        except _Return as r:
            return r.value
        return None

    def __repr__(self):
        return f"<fn {self.decl.name}>"


class _Return(Exception):
    def __init__(self, value):
        self.value = value


class Interpreter:
    def __init__(self):
        self.globals = Environment()
        self.output: list[str] = []     # print 출력 캡처 (테스트/임베드)

    def run(self, program: ast.Program):
        for stmt in program.statements:
            self._exec(stmt, self.globals)
        return self.output

    # --- 문 실행 ---
    def _exec(self, node, env: Environment):
        m = getattr(self, f"_exec_{type(node).__name__}", None)
        if m is None:
            raise RuntimeErr(f"실행 불가 노드 {type(node).__name__}", getattr(node, "line", 0))
        return m(node, env)

    def _exec_LetStmt(self, node: ast.LetStmt, env):
        env.define(node.name, self._eval(node.value, env))

    def _exec_ExprStmt(self, node: ast.ExprStmt, env):
        self._eval(node.expr, env)

    def _exec_PrintStmt(self, node: ast.PrintStmt, env):
        s = stringify(self._eval(node.expr, env))
        self.output.append(s)
        print(s)

    def _exec_Block(self, node: ast.Block, env):
        self._exec_block(node, Environment(env))

    def _exec_block(self, block: ast.Block, env: Environment):
        for stmt in block.statements:
            self._exec(stmt, env)

    def _exec_IfStmt(self, node: ast.IfStmt, env):
        if _truthy(self._eval(node.condition, env)):
            self._exec(node.then_branch, env)
        elif node.else_branch is not None:
            self._exec(node.else_branch, env)

    def _exec_WhileStmt(self, node: ast.WhileStmt, env):
        while _truthy(self._eval(node.condition, env)):
            self._exec(node.body, env)

    def _exec_FnDecl(self, node: ast.FnDecl, env):
        env.define(node.name, KairosFunction(node, env))

    def _exec_ReturnStmt(self, node: ast.ReturnStmt, env):
        value = self._eval(node.value, env) if node.value is not None else None
        raise _Return(value)

    # --- 표현식 평가 ---
    def _eval(self, node, env: Environment):
        m = getattr(self, f"_eval_{type(node).__name__}", None)
        if m is None:
            raise RuntimeErr(f"평가 불가 노드 {type(node).__name__}", getattr(node, "line", 0))
        return m(node, env)

    def _eval_NumberLit(self, node, env): return node.value
    def _eval_StringLit(self, node, env): return node.value
    def _eval_BoolLit(self, node, env): return node.value
    def _eval_NilLit(self, node, env): return None
    def _eval_PriceLit(self, node, env): return Price(node.amount, node.currency)
    def _eval_SharesLit(self, node, env): return Shares(node.amount)

    def _eval_Var(self, node: ast.Var, env):
        return env.get(node.name, node.line)

    def _eval_Assign(self, node: ast.Assign, env):
        value = self._eval(node.value, env)
        env.assign(node.name, value, node.line)
        return value

    def _eval_Unary(self, node: ast.Unary, env):
        v = self._eval(node.operand, env)
        if node.op == "not":
            return not _truthy(v)
        if node.op == "-":
            if isinstance(v, Price):
                return Price(-v.amount, v.currency)
            if isinstance(v, Shares):
                return Shares(-v.amount)
            if isinstance(v, Notional):
                return Notional(-v.amount, v.currency)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return -v
            raise KairosTypeError(f"단항 '-' 적용 불가: {type(v).__name__}", node.line)
        raise RuntimeErr(f"알 수 없는 단항 {node.op}", node.line)

    def _eval_Logical(self, node: ast.Logical, env):
        left = self._eval(node.left, env)
        if node.op == "or":
            return left if _truthy(left) else self._eval(node.right, env)
        return self._eval(node.right, env) if _truthy(left) else left

    def _eval_Binary(self, node: ast.Binary, env):
        l = self._eval(node.left, env)
        r = self._eval(node.right, env)
        op = node.op
        try:
            if op == "+": return _add(l, r)
            if op == "-": return l - r
            if op == "*": return l * r
            if op == "/": return _div(l, r, node.line)
            if op == "%": return l % r
            if op == "==": return _equal(l, r)
            if op == "!=": return not _equal(l, r)
            if op == "<": return l < r
            if op == ">": return l > r
            if op == "<=": return l <= r
            if op == ">=": return l >= r
        except KairosTypeError as e:
            raise KairosTypeError(e.message, node.line)
        except TypeError:
            raise KairosTypeError(
                f"'{op}' 연산 불가: {type(l).__name__} 와 {type(r).__name__}", node.line)
        raise RuntimeErr(f"알 수 없는 연산자 {op}", node.line)

    def _eval_Call(self, node: ast.Call, env):
        callee = self._eval(node.callee, env)
        args = [self._eval(a, env) for a in node.args]
        if isinstance(callee, KairosFunction):
            return callee.call(self, args)
        if callable(callee):                 # 내장 함수 (파이썬 콜러블)
            return callee(*args)
        raise RuntimeErr(f"호출 불가: {type(callee).__name__}", node.line)

    def _eval_Get(self, node: ast.Get, env):
        obj = self._eval(node.obj, env)
        # 차원 값의 내장 속성 (예: price.amount, notional.currency)
        if isinstance(obj, (Price, Notional)) and node.name in ("amount", "currency"):
            return getattr(obj, node.name)
        if isinstance(obj, Shares) and node.name == "amount":
            return obj.amount
        attr = getattr(obj, node.name, None)
        if attr is not None:
            return attr
        raise RuntimeErr(f"속성 '{node.name}' 없음", node.line)


def _truthy(v) -> bool:
    if v is None or v is False:
        return False
    return True


def _add(l, r):
    # 문자열 연결 + 숫자/차원 덧셈
    if isinstance(l, str) and isinstance(r, str):
        return l + r
    if isinstance(l, bool) or isinstance(r, bool):
        raise KairosTypeError("bool 에 '+' 적용 불가")
    return l + r


def _div(l, r, line):
    try:
        if isinstance(l, (int, float)) and isinstance(r, (int, float)) \
                and not isinstance(l, bool) and not isinstance(r, bool):
            if r == 0:
                raise RuntimeErr("0 으로 나눔", line)
            return l / r
        return l / r
    except ZeroDivisionError:
        raise RuntimeErr("0 으로 나눔", line)


def _equal(l, r) -> bool:
    # 서로 다른 종류는 False (예외 아님), 같은 종류는 값 비교
    return l == r


def interpret(program: ast.Program) -> list[str]:
    return Interpreter().run(program)
