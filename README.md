# Portfolio
Portfolio

## mybiz — 내 돈을 1인 사업체처럼

은행/카드 거래내역(CSV)을 복식부기로 분개해서 손익계산서·재무상태표·월별 실적·예산 대비 실적·런웨이를 보여준다.
내 계좌끼리 이체하거나 카드대금을 결제한 건은 수입/지출로 잡지 않고 자동으로 상계한다(중복 계상 방지).
데이터는 `./.mybiz/`에 저장되며 gitignore 처리돼 있다(`MYBIZ_HOME`으로 위치 변경 가능).

```bash
python3 -m mybiz import 국민은행.csv --source 자산:통장:국민
python3 -m mybiz import 신한카드.csv --source 부채:카드:신한
python3 -m mybiz rule 신한카드 부채:카드:신한 --direction out   # 카드대금 결제 = 부채 상환
python3 -m mybiz summary        # 이번 달 P&L + 순자산 + 런웨이
python3 -m mybiz pl --month 2026-09 | bs | monthly | budget | review
python3 -m mybiz tag <거래ID> 비용:변동:식비
```

분류 규칙·예산·기초잔액은 `.mybiz/config.json`에서 수정한다.
