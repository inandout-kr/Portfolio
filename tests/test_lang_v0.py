"""Kairos 언어 v0 테스트 — 렉서/파서/인터프리터 + 차원·통화 타입."""
import pytest

from kairoslang import run_source
from kairoslang.errors import KairosTypeError, ParseError, RuntimeErr
from kairoslang.lexer import tokenize
from kairoslang.tokens import T


def out(src):
    return run_source(src)


# --- 렉서 -------------------------------------------------------------------
def test_lexer_numbers_with_underscores():
    toks = tokenize("10_000_000")
    assert toks[0].type == T.NUMBER and toks[0].value == 10_000_000


def test_lexer_float_and_comment():
    toks = tokenize("1.5 # 주석\n2")
    types = [t.type for t in toks if t.type != T.EOF]
    assert types == [T.NUMBER, T.NUMBER]
    assert toks[0].value == 1.5


def test_lexer_operators():
    toks = tokenize("== != <= >= < > = + - * / %")
    assert [t.type for t in toks[:12]] == [
        T.EQEQ, T.BANGEQ, T.LE, T.GE, T.LT, T.GT,
        T.EQ, T.PLUS, T.MINUS, T.STAR, T.SLASH, T.PERCENT]


# --- 기본 값/산술 -----------------------------------------------------------
def test_print_int_and_float():
    assert out("print 3\nprint 2.5") == ["3", "2.5"]


def test_arithmetic_precedence():
    assert out("print 2 + 3 * 4") == ["14"]
    assert out("print (2 + 3) * 4") == ["20"]


def test_string_concat():
    assert out('print "a" + "b"') == ["ab"]


def test_bool_and_logical():
    assert out("print true and false\nprint true or false\nprint not true") == \
        ["false", "true", "false"]


# --- 차원·통화 타입 ---------------------------------------------------------
def test_price_times_shares_is_notional():
    assert out("print KRW 70000 * 50 shares") == ["3,500,000 KRW (notional)"]


def test_shares_times_price_commutes():
    assert out("print 50 shares * KRW 70000") == ["3,500,000 KRW (notional)"]


def test_notional_div_price_is_shares():
    assert out("print (KRW 70000 * 50 shares) / KRW 70000") == ["50 shares"]


def test_notional_div_shares_is_price():
    assert out("print (KRW 70000 * 50 shares) / 50 shares") == ["70,000 KRW"]


def test_price_plus_price_same_currency():
    assert out("print KRW 100 + KRW 50") == ["150 KRW"]


def test_price_cross_currency_is_type_error():
    with pytest.raises(KairosTypeError):
        out("print KRW 100 + USD 1")


def test_price_times_shares_then_compare():
    assert out("print (KRW 100 * 10 shares) > (KRW 100 * 5 shares)") == ["true"]


def test_shares_arithmetic():
    assert out("print 10 shares + 5 shares") == ["15 shares"]


def test_price_div_price_is_ratio():
    assert out("print KRW 200 / KRW 100") == ["2"]


def test_negation_of_dimensional():
    assert out("print -(KRW 100)") == ["-100 KRW"]


# --- 변수 / 대입 ------------------------------------------------------------
def test_let_and_use():
    assert out("let x = 10\nprint x + 5") == ["15"]


def test_let_with_type_annotation_ignored():
    assert out("let p: Price<KRW> = KRW 100\nprint p") == ["100 KRW"]


def test_assignment_updates():
    assert out("let x = 1\nx = x + 9\nprint x") == ["10"]


def test_undefined_variable_errors():
    with pytest.raises(RuntimeErr):
        out("print y")


# --- 제어 흐름 --------------------------------------------------------------
def test_if_else():
    assert out("if 1 < 2 { print 1 } else { print 2 }") == ["1"]
    assert out("if 1 > 2 { print 1 } else { print 2 }") == ["2"]


def test_else_if_chain():
    src = "let x = 5\nif x > 9 { print 1 } else if x > 3 { print 2 } else { print 3 }"
    assert out(src) == ["2"]


def test_while_loop():
    src = "let i = 0\nlet s = 0\nwhile i < 5 { s = s + i\ni = i + 1 }\nprint s"
    assert out(src) == ["10"]


# --- 함수 -------------------------------------------------------------------
def test_function_call_and_return():
    src = "fn add(a, b) { return a + b }\nprint add(3, 4)"
    assert out(src) == ["7"]


def test_function_dimensional_pnl():
    src = ("fn pnl(entry, exit, qty) { return (exit - entry) * qty }\n"
           "print pnl(KRW 70000, KRW 73000, 50 shares)")
    assert out(src) == ["150,000 KRW (notional)"]


def test_function_closure_and_recursion():
    src = ("fn fact(n) { if n <= 1 { return 1 }\nreturn n * fact(n - 1) }\n"
           "print fact(5)")
    assert out(src) == ["120"]


def test_function_arity_error():
    with pytest.raises(RuntimeErr):
        out("fn f(a) { return a }\nprint f(1, 2)")


def test_property_access_on_dimensional():
    assert out("let p = KRW 100 * 3 shares\nprint p.amount\nprint p.currency") == \
        ["300", "KRW"]


# --- 파서 에러 --------------------------------------------------------------
def test_parse_error_on_missing_brace():
    with pytest.raises(ParseError):
        out("if 1 < 2 { print 1")


def test_parse_error_unexpected_token():
    with pytest.raises(ParseError):
        out("print *")
