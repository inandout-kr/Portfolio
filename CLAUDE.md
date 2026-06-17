# Kairos — 자동 알파 발굴 시스템 (프로젝트 브리프)

## 새 Claude Code 세션 시작 방법
이 `CLAUDE.md` 와 `kairos_verifier.py` 를 프로젝트 루트에 두면 Claude Code 가 이 파일을 자동으로 읽는다.

- **다음 작업**: §11 의 3개 결정은 모두 확정됨(아래 참조). §10 로드맵에서 다음 미완료 항목(현재 **3번 PIT 데이터 레이어**)을 진행한다.
- 이 문서는 자기완결적이다. 이전 대화 기록 없이도 전체 맥락을 담고 있다.

## 1. 프로젝트 목표
한국 주식·선물 시장에서 실제로 적용 가능한 트레이딩 알파를 자동으로 발굴하는 폐루프 시스템. 단순 백테스트 도구가 아니라, 과최적화·룩어헤드·현실화 불가능 전략을 무자비하게 걸러내는 **검증 중심 시스템**이다. 막히면 스스로 진단·처치하고 발굴 단계로 복귀하는 supervisor 루프까지 포함한다.

## 2. 핵심 도그마 (이걸 어기면 시스템이 망한다)
- **생성은 쉽다. 검증기가 전부다.** 시스템의 본질은 "돈 버는 기계"가 아니라 버리는 필터다.
- 자동 탐색 = 거대한 다중검정 문제. 1만 개 돌려 최고 샤프를 고르면 알파가 아니라 노이즈를 고른 것이다.
- 생 샤프는 절대 믿지 않는다. 항상 **전역 누적 시도 횟수로 deflate** 한 뒤에만 본다.
- 비용은 항상 보수적으로(높게). 낙관적 비용 = 가짜 알파 1번 원인.
- 포워드/페이퍼 성과가 백테스트보다 우선한다. 데이터가 더러울수록 더 그렇다.
- 라이브 자본 투입 전 **휴먼 게이트는 제거 불가**. 완전자율 아님, 반자율.
- 한국 시장 특수성은 타협 대상이 아니다 (거래세·공매도 제약·가격제한·서킷브레이커·VI·단일가매매).

## 3. 물리쳐야 할 세 가지 적

| 적 | 방어 수단 |
|----|-----------|
| **과최적화** | Deflated Sharpe Ratio(전역 다중검정), PBO via CSCV, 워크포워드 OOS, 파라미터 민감도·레짐 강건성 |
| **룩어헤드 바이어스** | Kairos 시간 타입 시스템으로 구조적 차단 + 엄격한 PIT 데이터. 생존편향도 룩어헤드의 일종으로 취급 |
| **현실화 불가능** | 현실화 시뮬레이터: 한국 비용(수수료+매도거래세 20bp), 제곱근 시장충격, 캐퍼시티, 공매도 차입제약, 가격제한/서킷/VI, 호가·수량단위 |

## 4. 아키텍처

### 안쪽 루프 — 발굴 파이프라인
1. **생성**: 모든 후보는 *경제적 메커니즘(thesis)* 을 달고 나온다 (위험프리미엄/행동/미시구조/수급). 이유 없는 전략은 감점. LLM 가설 제안 또는 Kairos 프리미티브 위 유전 프로그래밍.
2. **컴파일 가드**: 룩어헤드는 타입 레벨에서 표현 자체가 불가능. PIT 유니버스(상폐 포함) 필수.
3. **현실화 시뮬레이터**: §8 참조. 데이터에 없는 슬리피지는 모델링.
4. **통계 검증**: `kairos_verifier.py` 사용. DSR 의 N 은 전역 누적 시도 수.
5. **승격 게이트**: 통과분만 페이퍼 → 포워드 성과(편향 없음)로 최종 판정 → 라이브 피드백.

### 바깥쪽 루프 — supervisor (막히면 해결하고 복귀)
실패 분류 → 진단 → 처치 → 발굴 재개 의 상태머신.
- 데이터 결손/이상치 → 클리닝 후 재개
- 유동성 부족 현실화 실패 → 재파라미터화 or 폐기
- 라이브 vs 백테스트 괴리 → 원인 진단(레짐/비용모델/알파감쇠) → 재캘리브 or 은퇴
- 영구 상태: 전역 시도 원장(DSR 다중검정용), 실패 로그(반복 실패 모드 학습 → 가드 강화)

## 5. Kairos 언어 설계 (전략 기술용 DSL)
**한 줄 아이디어: 시간을 타입으로.** 그리스어 chronos(흐르는 시계 시간) vs kairos(행동할 결정적 순간). 트레이딩 버그 대부분은 이 둘의 혼동(=룩어헤드)에서 온다. 미래는 타입 차원에서 접근 불가능 → 컴파일러가 막는다.

### 4개 기둥
- **시간 안전성**: 시계열은 자유 인덱싱 불가, `now` 기준 과거까지만 인과적 접근.
- **차원·통화 타입**: `Price<KRW> * Shares → Notional<KRW>` OK / `Price<KRW> + Price<USD>` 컴파일 에러.
- **한 번 짜고 세 모드**: 같은 전략이 backtest/paper/live 에서 그대로 (실행 컨텍스트 다형성).
- **일급 시장 원시타입 + 반응형 블록**: `Order`/`Position`/`Book` 내장, `on bar`/`tick`/`fill`.

> 문법 예시: (원본 코드 예시 미포함 — DSL 확정 시 작성)

**구현 방향 (확정 필요 — §11)**: Python 임베디드 DSL 로 구현 추천. 데코레이터/연산자 오버로딩으로 rolling, 단위 타입, 룩어헤드 차단을 라이브러리화 → 사용자의 기존 백테스트 엔진(룩어헤드 방지 내장)에 바로 얹음. (대안: Python 트랜스파일러.)

## 6. 데이터 제약 (사용자 실제 환경 — 매우 중요)
- **유니버스**: 현재 상장 티커만. 상폐 종목 미포함 → 생존편향 있음. 신규 상장은 주기적으로 업뎃 가능.
- **비용(사용자 제공)**: 선물 1bp, 현물 3bp. → 수수료(편도)로 해석, 슬리피지·거래세 미포함.
- **거래세(사용자 숫자에 없음)**: 2026.01 시행, 매도 시·현물만. 코스피 0.05%+농특세 0.15% = 0.20%, 코스닥 0.20%. → 20bp.
- **데이터 주기**: 1분봉 ~ 일봉 (틱/호가창 없음).
- **귀결**: "분~일" 알파 영역으로 한정 (HFT/미시구조 제외). 슬리피지는 명시적 모델링. 체결은 같은 바 종가 아니라 다음 바 기준.

## 7. 비용 현실 — 33bp 벽
- 진짜 현물 왕복비용 = 수수료 6bp + 매도거래세 20bp + 슬리피지 ≈ **33bp**. (선물 ≈ 9bp.)
- 이 벽이 고회전 현물 전략의 대부분을 자동으로 죽인다 — 버그가 아니라 기능. 트레이드당 33bp 를 못 이기면 폐기.

## 8. 생존편향 4중 방어
1. 유니버스를 유동성 상위(코스피200급)로 제한 → 통째 상폐 드물어 편향 최소화.
2. 알파 엣지가 "나중에 문제 된 종목"에 몰리면 자동 플래그.
3. DART 관리종목/상폐 스크리너로 지금부터 상폐를 로깅 → 시간이 갈수록 진짜 PIT 유니버스 완성. (신규상장 업뎃 루틴에 상폐 로깅 추가.)
4. 페이퍼/포워드 검증은 생존편향에 면역 → 승격 게이트에 더 크게 의존.

> ※ 편향 방향: 롱/역추세/밸류/저가주/디스트레스드는 위로, 숏은 아래로 편향됨.

## 9. 현재 상태 (작동 확인 완료)
사용자 백테스트 엔진에 그대로 얹는 형태. 의존성: numpy, scipy (테스트: pytest).

### `kairos_verifier.py` — 검증기 코어
- **`KoreanCostModel`** — 한국 비용/슬리피지. 메서드: `one_way_bps(side, instrument, participation, sigma_bps)`, `round_trip_bps(...)`, `slippage_bps(...)`. 기본값: 선물수수료 1bp, 현물수수료 3bp, 현물매도거래세 20bp, half_spread 2bp, 제곱근충격계수 0.8.
- **과최적화 가드**: `sharpe`, `probabilistic_sharpe_ratio(returns, sr_benchmark)`, `expected_max_sharpe(n_trials, sr_variance)`, `deflated_sharpe_ratio(returns, n_trials, sr_variance)`, `pbo_cscv(returns_matrix, n_splits)`.
- **실행**: `python3 kairos_verifier.py`

### `kairos_simulator.py` — 현실화 시뮬레이터
- **타입**: `Bar`(OHLCV+거래대금, `halted`, `limit_up/down`), `Order`(side/instrument/shares/is_short), `Fill`, `ExecutionReport`(`filled/remaining_shares`, `avg_fill_price`, `slippage_bps` = implementation shortfall, `total_cost_krw`).
- **`RealizationSimulator.execute(order, future_bars, prev_close=None)`** — 다음 바부터 체결. 바당 `max_participation`(기본 10%)까지만 먹고 나머지 이월(캐퍼시티). 가격제한 잠김/정지(halt) 바 스킵, 공매도 차입 불가 시 기각. 비용은 `KoreanCostModel` 위임.
- **`capacity_analysis(adv_krw, target_notional, max_daily_participation)`** → `CapacityReport`(소화 일수/당일가능 여부).
- **실행**: `python3 kairos_simulator.py`

### `kairos_pit.py` — PIT 데이터 레이어
- **`PITUniverse`** — `add_listing`, `log_delisting(ticker, delisted_on, recorded_on)`, `as_of(date)`(생존편향 없는 시점별 유니버스), `is_unbiased_asof(date)`(coverage_start 기준), `delisted_between(start, end)`.
- **`as_of_join(timestamps, records, allow_same_timestamp=False)`** — 각 시점까지 알 수 있던 최신 `PITRecord.value`. 기본 strict(`<`)로 같은 바 누수 차단, `allow_same_timestamp=True`면 `<=`.
- **`assert_no_same_bar_leak(signal_effective_at, decision_ts)`** — 같은 바/미래 정보면 예외 (시뮬레이터 '다음 바 체결'의 데이터쪽 짝).
- **라이브 가정**: 실제 시세/펀더멘털/DART 상폐 소스는 미연동. 인메모리 인터페이스로 PIT 로직 확정.
- **실행**: `python3 kairos_pit.py`

### `kairos_dsl.py` — 임베디드 DSL
- **차원·통화 타입**: `Price(value, ccy)`, `Shares(value)`, `Notional(value, ccy)`. `Price*Shares→Notional`, `Notional/Price→Shares`, `Notional/Shares→Price`. 통화 불일치 덧셈/나눗셈은 `TypeError`.
- **`CausalSeries`** — `now()`, `ago(k)`(k≥0, 음수면 `LookAheadError`), `window(n)`, `seek/advance`. 자유 인덱싱(`__getitem__`)은 막힘 → 룩어헤드 구조적 차단.
- **`run_reactive(series, on_bar)`** — 모든 시계열을 같은 t로 흘리며 `on_bar(Context)` 호출, 반환 시그널을 `(t, value)`로 수집. 핸들러는 인과적 접근만 가능.
- **실행**: `python3 kairos_dsl.py`

### 테스트
- `tests/` — `test_verifier.py`, `test_simulator.py`, `test_pit.py`, `test_dsl.py`. **실행: `python3 -m pytest -q` (현재 61 passed).**

### 데모 출력 (실측)
```
=== 1) 비용 모델 ===
현물 왕복비용 : 32.9 bp  (수수료6 + 거래세20 + 슬리피지)
선물 왕복비용 : 8.9 bp
-> 현물 일중 회전 전략은 트레이드당 최소 33bp 를 이겨야 함

=== 2) Deflated Sharpe Ratio ===
강한 알파 | per-period SR=+0.188 | PSR=1.000 | DSR(N=100)=0.835 | DSR(N=10만)=0.001
노이즈  | per-period SR=+0.005 | PSR=0.565 | DSR(N=100)=0.000 | DSR(N=10만)=0.000
-> 같은 알파도 시도(N)가 늘수록 통과 기준이 올라감. 노이즈는 어디서도 통과 못함.

=== 3) PBO (CSCV) ===
전부 노이즈 (8시드 평균) : PBO = 0.447  (0.5 근처여야 정상)
1개 지속 알파            : PBO = 0.003  (0 근처여야 정상)
```

## 10. 빌드 로드맵 (우선순위 순)
1. ✅ 검증기 코어 (비용모델 + 과최적화 가드) — `kairos_verifier.py` 완료
2. ✅ 현실화 시뮬레이터 ③ — `kairos_simulator.py` 완료. 다음 바 체결, 참여율 기반 슬리피지(비용은 `KoreanCostModel` 위임), 캐퍼시티 이월/분석, 공매도 차입제약, 가격제한(±30%)/서킷·VI 정지 처리
3. ✅ PIT 데이터 레이어 — `kairos_pit.py` 완료. as-of 유니버스(생존편향 차단), 상폐 전향 수집(coverage_start), as-of 조인(strict=같은 바 누수 차단), same-bar leak 가드. (라이브 데이터 소스 미연동 — 인메모리 인터페이스/로직 우선)
4. ✅ Kairos 임베디드 DSL — `kairos_dsl.py` 완료. 차원·통화 타입(Price/Shares/Notional), 인과적 Series(미래/자유인덱싱 차단), 반응형 블록(run_reactive).
5. ⬜ 생성기 — thesis 동반 가설 제안(LLM/GP), 경제적 근거 강제 **(다음 작업)**
6. ⬜ 통계 검증 하니스 — 워크포워드 + CSCV/PBO + DSR(전역 시도 원장 연동) + 안정성/레짐 테스트
7. ⬜ 승격 게이트 + 페이퍼 + 라이브 피드백
8. ⬜ 바깥쪽 supervisor 루프 — 실패 분류·처치 정책, 영구 시도원장+실패로그, 재개

## 11. 확정된 결정 3개 (2026-06 확정)
1. ✅ **3bp = 수수료 편도(거래세 별도)** → `KoreanCostModel` 기본값(매도 거래세 20bp 자동 가산) 유지.
2. ✅ **시작 유니버스 = 코스피200급 유동주 제한** (생존편향↓). 시뮬레이터 기본값 `borrowable_short=True` 도 이 가정과 정합.
3. ✅ **Kairos 구현 = Python 임베디드 DSL** (데코레이터/연산자 오버로딩 + 기존 백테스트 엔진 위). 트랜스파일러 아님.

## 12. 참고문헌
- Bailey & López de Prado (2012/2014): Probabilistic / Deflated Sharpe Ratio
- Bailey, Borwein, López de Prado, Zhu (2017): The Probability of Backtest Overfitting (CSCV)
- Harvey & Liu: Backtesting / multiple testing in finance
- Almgren et al.: square-root market impact
- Hasbrouck: Empirical Market Microstructure
