# Kairos 언어

알고리즘 트레이딩에 특화된 **독립 프로그래밍 언어**. 자체 문법(`.ka`) →
렉서 → 파서 → AST → **트리워킹 인터프리터**. (Python 라이브러리 `kairos_*.py`
발굴 시스템과는 별개 — 이쪽은 *언어 자체*.)

## 실행
```bash
python3 -m kairoslang run examples/hello.ka     # 파일 실행
python3 -m kairoslang eval 'print KRW 70000 * 50 shares'   # 한 줄 실행
```

## 설계: 4기둥 (그리스어 chronos=흐르는 시간 vs kairos=결정의 순간)
트레이딩 버그 대부분은 "미래를 본다(룩어헤드)"와 "단위를 섞는다"에서 온다.
Kairos는 이 둘을 **언어 차원**에서 막는 것을 목표로 한다.

1. **차원·통화 타입** ✅(v0) — `Price<KRW> * Shares → Notional<KRW>`,
   `Price<KRW> + Price<USD>`는 타입 에러.
2. **시간 안전성** ⬜ — 인과적 시계열. `close.now()`/`close.ago(k)`만 허용,
   미래 접근은 컴파일/런타임에서 차단.
3. **한 번 짜고 세 모드** ⬜ — 같은 전략을 backtest/paper/live 로.
4. **일급 시장 원시타입 + 반응형 블록** ⬜ — `Order`/`Position`/`Book` 내장,
   `on bar`/`tick`/`fill`.

## v0 문법 (현재 동작)
```kairos
# 주석
print "hello"

# 차원·통화 타입
let price: Price<KRW> = KRW 70000      # 통화 접두 = 가격 리터럴
let qty: Shares = 50 shares            # 숫자 + 단위 = 수량 리터럴
let cost: Notional<KRW> = price * qty  # Price * Shares -> Notional
print cost / price                     # Notional / Price -> Shares

# 함수 / 제어 흐름 / 반복
fn pnl(entry, exit, qty) { return (exit - entry) * qty }
if ret > 0.0 { print "up" } else { print "down" }
while i < n { i = i + 1 }
```

| 기능 | 상태 |
|------|------|
| Int/Float/Bool/String/nil, 산술·비교·논리 | ✅ |
| 변수(`let`, `:` 타입주석), 대입 | ✅ |
| `if/else if/else`, `while` | ✅ |
| `fn`(클로저·재귀), `return`, `print` | ✅ |
| 차원·통화 타입(Price/Shares/Notional) | ✅ |
| 속성 접근(`.amount`, `.currency`) | ✅ |
| 인과적 시계열 / `on bar` / 주문 / 3모드 | ⬜ (다음 단계) |

## 예약어
`let fn return if else while true false nil print and or not`
및 단위 `KRW USD shares sh` (단위는 예약어 — 변수명으로 못 씀).

## 구조
```
kairoslang/
  tokens.py  lexer.py  ast.py  parser.py
  runtime.py        # 차원·통화 값 + 연산 규칙
  interpreter.py    # 트리워킹 실행기
  errors.py  cli.py  __main__.py
examples/hello.ka
tests/test_lang_v0.py   # 31 tests
```
