"""Kairos 언어 — 파서 (토큰 → AST). 재귀하강 + 우선순위."""
from __future__ import annotations

from . import ast
from .errors import ParseError
from .tokens import T, Token


class Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.i = 0

    # --- 토큰 헬퍼 ---
    def _peek(self) -> Token:
        return self.tokens[self.i]

    def _prev(self) -> Token:
        return self.tokens[self.i - 1]

    def _at_end(self) -> bool:
        return self._peek().type == T.EOF

    def _check(self, type: T) -> bool:
        return not self._at_end() and self._peek().type == type

    def _advance(self) -> Token:
        if not self._at_end():
            self.i += 1
        return self._prev()

    def _match(self, *types: T) -> bool:
        for t in types:
            if self._check(t):
                self._advance()
                return True
        return False

    def _expect(self, type: T, msg: str) -> Token:
        if self._check(type):
            return self._advance()
        raise ParseError(msg, self._peek().line)

    # --- 진입 ---
    def parse(self) -> ast.Program:
        stmts = []
        while not self._at_end():
            stmts.append(self._declaration())
        return ast.Program(stmts)

    # --- 문 ---
    def _declaration(self):
        if self._match(T.FN):
            return self._fn_decl()
        if self._match(T.LET):
            return self._let_stmt()
        return self._statement()

    def _fn_decl(self):
        line = self._prev().line
        name = self._expect(T.IDENT, "함수 이름이 필요합니다").lexeme
        self._expect(T.LPAREN, "'(' 가 필요합니다")
        params = []
        if not self._check(T.RPAREN):
            params.append(self._expect(T.IDENT, "파라미터 이름").lexeme)
            while self._match(T.COMMA):
                params.append(self._expect(T.IDENT, "파라미터 이름").lexeme)
        self._expect(T.RPAREN, "')' 가 필요합니다")
        body = self._block()
        return ast.FnDecl(name, params, body, line)

    def _let_stmt(self):
        line = self._prev().line
        name = self._expect(T.IDENT, "변수 이름이 필요합니다").lexeme
        type_ann = None
        if self._match(T.COLON):
            type_ann = self._type_annotation()
        self._expect(T.EQ, "'=' 가 필요합니다")
        value = self._expression()
        self._match(T.SEMI)
        return ast.LetStmt(name, type_ann, value, line)

    def _type_annotation(self) -> str:
        name = self._expect(T.IDENT, "타입 이름").lexeme
        if self._match(T.LT):                      # 제네릭: Price<KRW>
            inner = self._advance().lexeme
            self._expect(T.GT, "'>' 가 필요합니다")
            return f"{name}<{inner}>"
        return name

    def _statement(self):
        if self._match(T.PRINT):
            return self._print_stmt()
        if self._match(T.IF):
            return self._if_stmt()
        if self._match(T.WHILE):
            return self._while_stmt()
        if self._match(T.RETURN):
            return self._return_stmt()
        if self._check(T.LBRACE):
            return self._block()
        return self._expr_stmt()

    def _print_stmt(self):
        line = self._prev().line
        expr = self._expression()
        self._match(T.SEMI)
        return ast.PrintStmt(expr, line)

    def _if_stmt(self):
        line = self._prev().line
        cond = self._expression()
        then = self._block()
        els = None
        if self._match(T.ELSE):
            els = self._if_stmt() if self._match(T.IF) else self._block()
        return ast.IfStmt(cond, then, els, line)

    def _while_stmt(self):
        line = self._prev().line
        cond = self._expression()
        body = self._block()
        return ast.WhileStmt(cond, body, line)

    def _return_stmt(self):
        line = self._prev().line
        value = None
        if not self._check(T.RBRACE) and not self._check(T.SEMI) and not self._at_end():
            value = self._expression()
        self._match(T.SEMI)
        return ast.ReturnStmt(value, line)

    def _block(self) -> ast.Block:
        line = self._expect(T.LBRACE, "'{' 가 필요합니다").line
        stmts = []
        while not self._check(T.RBRACE) and not self._at_end():
            stmts.append(self._declaration())
        self._expect(T.RBRACE, "'}' 가 필요합니다")
        return ast.Block(stmts, line)

    def _expr_stmt(self):
        expr = self._expression()
        self._match(T.SEMI)
        return ast.ExprStmt(expr, expr.line)

    # --- 표현식 (우선순위 낮음→높음) ---
    def _expression(self):
        return self._assignment()

    def _assignment(self):
        expr = self._or()
        if self._match(T.EQ):
            eq = self._prev()
            value = self._assignment()
            if isinstance(expr, ast.Var):
                return ast.Assign(expr.name, value, eq.line)
            raise ParseError("대입 대상이 올바르지 않습니다", eq.line)
        return expr

    def _or(self):
        expr = self._and()
        while self._match(T.OR):
            line = self._prev().line
            expr = ast.Logical("or", expr, self._and(), line)
        return expr

    def _and(self):
        expr = self._equality()
        while self._match(T.AND):
            line = self._prev().line
            expr = ast.Logical("and", expr, self._equality(), line)
        return expr

    def _equality(self):
        expr = self._comparison()
        while self._match(T.EQEQ, T.BANGEQ):
            op = self._prev().lexeme
            expr = ast.Binary(op, expr, self._comparison(), self._prev().line)
        return expr

    def _comparison(self):
        expr = self._term()
        while self._match(T.LT, T.GT, T.LE, T.GE):
            op = self._prev().lexeme
            expr = ast.Binary(op, expr, self._term(), self._prev().line)
        return expr

    def _term(self):
        expr = self._factor()
        while self._match(T.PLUS, T.MINUS):
            op = self._prev().lexeme
            expr = ast.Binary(op, expr, self._factor(), self._prev().line)
        return expr

    def _factor(self):
        expr = self._unary()
        while self._match(T.STAR, T.SLASH, T.PERCENT):
            op = self._prev().lexeme
            expr = ast.Binary(op, expr, self._unary(), self._prev().line)
        return expr

    def _unary(self):
        if self._match(T.MINUS, T.NOT):
            op = self._prev().lexeme
            line = self._prev().line
            return ast.Unary(op, self._unary(), line)
        return self._call()

    def _call(self):
        expr = self._primary()
        while True:
            if self._match(T.LPAREN):
                expr = self._finish_call(expr)
            elif self._match(T.DOT):
                name = self._expect(T.IDENT, "속성 이름이 필요합니다")
                expr = ast.Get(expr, name.lexeme, name.line)
            else:
                break
        return expr

    def _finish_call(self, callee):
        line = self._prev().line
        args = []
        if not self._check(T.RPAREN):
            args.append(self._expression())
            while self._match(T.COMMA):
                args.append(self._expression())
        self._expect(T.RPAREN, "')' 가 필요합니다")
        return ast.Call(callee, args, line)

    def _primary(self):
        tok = self._peek()
        if self._match(T.TRUE):
            return ast.BoolLit(True, tok.line)
        if self._match(T.FALSE):
            return ast.BoolLit(False, tok.line)
        if self._match(T.NIL):
            return ast.NilLit(tok.line)
        if self._match(T.NUMBER):
            num = self._prev()
            if self._check(T.UNIT_SHARES):       # 50 shares
                self._advance()
                return ast.SharesLit(num.value, num.line)
            return ast.NumberLit(num.value, num.line)
        if self._match(T.CURRENCY):              # KRW 10000  (Price 리터럴)
            ccy = self._prev().value
            amt = self._expect(T.NUMBER, "통화 뒤에는 가격(숫자)이 와야 합니다")
            return ast.PriceLit(amt.value, ccy, tok.line)
        if self._match(T.STRING):
            return ast.StringLit(self._prev().value, tok.line)
        if self._match(T.IDENT):
            return ast.Var(self._prev().lexeme, tok.line)
        if self._match(T.LPAREN):
            expr = self._expression()
            self._expect(T.RPAREN, "')' 가 필요합니다")
            return expr
        raise ParseError(f"예상치 못한 토큰 {tok.lexeme!r}", tok.line)


def parse(tokens: list[Token]) -> ast.Program:
    return Parser(tokens).parse()
