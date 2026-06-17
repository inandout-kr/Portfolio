"""
kairos/verifier.py
==================
검증기(verifier) 코어 — 자동 알파 탐색 루프에서 "버리는 일"을 담당하는 모듈.

두 부분으로 구성:
  1) KoreanCostModel : 한국 시장 현실 비용/슬리피지 (선물/현물, 거래세, 제곱근 충격)
  2) Overfitting guards : PSR, Deflated Sharpe Ratio, PBO(CSCV)

설계 원칙
  - 비용은 항상 보수적으로(높게) 잡는다. 낙관적 비용 = 가짜 알파의 1번 원인.
  - 샤프는 절대 그냥 믿지 않는다. 시도 횟수로 deflate 한 뒤에만 본다.
  - look-ahead 는 여기서 안 막는다. 그건 데이터/Kairos 타입 레벨에서 이미 막혀 있어야 함.

References
  - Bailey & López de Prado (2012/2014): Probabilistic / Deflated Sharpe Ratio
  - Bailey, Borwein, López de Prado, Zhu (2017): The Probability of Backtest Overfitting
  - Almgren et al.: square-root market impact
"""
from __future__ import annotations
from dataclasses import dataclass
from itertools import combinations
import numpy as np
from scipy.stats import norm

EULER_GAMMA = 0.5772156649015329


# ---------------------------------------------------------------------------
# 1) 한국 시장 비용/슬리피지 모델
# ---------------------------------------------------------------------------
@dataclass
class KoreanCostModel:
    """
    한 번의 약정(one-way)에 대한 체결 비용을 bp 단위로 반환.

    사용자 입력 가정
      - 선물 1bp, 현물 3bp  -> 여기서는 '수수료(commission)'로 해석 (슬리피지 미포함)
      - 거래세는 별도. 2026.01 기준 매도 시 코스피/코스닥 모두 총 0.20% (=20bp).
        (코스피 = 증권거래세 0.05% + 농특세 0.15%, 코스닥 = 증권거래세 0.20%)
        => 매도에만, 현물에만 부과. 선물엔 없음.

    슬리피지(=시장충격)는 데이터에 없으므로 반드시 '모델링'한다.
      impact_bps = half_spread_bps + k * sigma_bps * sqrt(participation)
      participation = 주문금액 / 해당 바(예: 1분봉) 거래대금
    """
    # 수수료 (one-way, bp)
    fut_commission_bps: float = 1.0
    eq_commission_bps: float = 3.0
    # 매도 거래세 (현물, sell-only, bp) — 2026 기준 20bp
    eq_sell_tax_bps: float = 20.0
    fut_sell_tax_bps: float = 0.0
    # 슬리피지 모델 파라미터
    half_spread_bps: float = 2.0   # 호가 절반. 대형주 작게, 소형주 크게 잡을 것.
    impact_k: float = 0.8          # 제곱근 충격 계수 (보수적으로 0.5~1.0)

    def slippage_bps(self, participation: float, sigma_bps: float) -> float:
        """제곱근 시장충격. participation 은 (주문금액 / 바 거래대금)."""
        participation = max(0.0, float(participation))
        return self.half_spread_bps + self.impact_k * sigma_bps * np.sqrt(participation)

    def one_way_bps(self, side: str, instrument: str,
                    participation: float = 0.0, sigma_bps: float = 0.0) -> float:
        """side: 'buy'|'sell', instrument: 'eq'|'fut'."""
        if instrument == "eq":
            cost = self.eq_commission_bps
            if side == "sell":
                cost += self.eq_sell_tax_bps
        elif instrument == "fut":
            cost = self.fut_commission_bps
            if side == "sell":
                cost += self.fut_sell_tax_bps
        else:
            raise ValueError(f"unknown instrument: {instrument}")
        cost += self.slippage_bps(participation, sigma_bps)
        return cost

    def round_trip_bps(self, instrument: str,
                       participation: float = 0.0, sigma_bps: float = 0.0) -> float:
        """진입+청산 왕복 비용. 고회전 전략을 죽이는 핵심 숫자."""
        buy = self.one_way_bps("buy", instrument, participation, sigma_bps)
        sell = self.one_way_bps("sell", instrument, participation, sigma_bps)
        return buy + sell


# ---------------------------------------------------------------------------
# 2) 과최적화 가드
# ---------------------------------------------------------------------------
def sharpe(returns: np.ndarray) -> float:
    """per-period(비연율화) 샤프."""
    r = np.asarray(returns, dtype=float)
    sd = r.std(ddof=1)
    return float(r.mean() / sd) if sd > 0 else 0.0


def probabilistic_sharpe_ratio(returns: np.ndarray, sr_benchmark: float = 0.0) -> float:
    """
    PSR: 관측 샤프가 benchmark 샤프보다 진짜로 높을 확률.
    비정규성(왜도/첨도)과 표본길이를 반영. 모두 per-period 기준.
    """
    r = np.asarray(returns, dtype=float)
    n = len(r)
    sr = sharpe(r)
    sd = r.std(ddof=1)
    if n < 3 or sd == 0:
        return 0.0
    skew = float(((r - r.mean())**3).mean() / sd**3)
    kurt = float(((r - r.mean())**4).mean() / sd**4)  # non-excess (정규분포=3)
    denom = np.sqrt(1 - skew * sr + ((kurt - 1) / 4) * sr**2)
    z = (sr - sr_benchmark) * np.sqrt(n - 1) / denom
    return float(norm.cdf(z))


def expected_max_sharpe(n_trials: int, sr_variance: float) -> float:
    """
    N번 시도했을 때 '운으로' 기대되는 최대 per-period 샤프 (deflation 기준선 SR0).
    sr_variance = 시도들 간 per-period 샤프의 분산.
    """
    if n_trials < 2 or sr_variance <= 0:
        return 0.0
    e = np.e
    z1 = norm.ppf(1 - 1.0 / n_trials)
    z2 = norm.ppf(1 - 1.0 / (n_trials * e))
    return float(np.sqrt(sr_variance) * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2))


def deflated_sharpe_ratio(returns: np.ndarray, n_trials: int, sr_variance: float) -> float:
    """
    DSR: 시도 횟수(N)와 시도간 샤프 분산을 반영해 deflate 한 PSR.
    n_trials 는 '루프 전체 역사'에서의 누적 시도 수여야 한다 (전역 다중검정).
    반환값(확률)이 임계치(예: 0.95) 미만이면 기각.
    """
    sr0 = expected_max_sharpe(n_trials, sr_variance)
    return probabilistic_sharpe_ratio(returns, sr_benchmark=sr0)


def pbo_cscv(returns_matrix: np.ndarray, n_splits: int = 16) -> float:
    """
    PBO (Probability of Backtest Overfitting) via Combinatorially Symmetric CV.

    returns_matrix : shape (T, N). T=시간, N=전략(파라미터 조합).
    n_splits S : 짝수. 시간축을 S개 블록으로 나눠 C(S, S/2)개 IS/OOS 조합 생성.
    반환: IS 최적 전략이 OOS 에서 중앙값 미만으로 떨어질 확률. 0.5 근처/이상이면 위험.
    """
    M = np.asarray(returns_matrix, dtype=float)
    T, N = M.shape
    if n_splits % 2 != 0:
        raise ValueError("n_splits must be even")
    block_size = T // n_splits
    blocks = [M[i * block_size:(i + 1) * block_size] for i in range(n_splits)]

    logits = []
    idx = list(range(n_splits))
    for is_blocks in combinations(idx, n_splits // 2):
        oos_blocks = [b for b in idx if b not in is_blocks]
        IS = np.vstack([blocks[b] for b in is_blocks])
        OOS = np.vstack([blocks[b] for b in oos_blocks])

        is_perf = np.array([sharpe(IS[:, n]) for n in range(N)])
        oos_perf = np.array([sharpe(OOS[:, n]) for n in range(N)])

        best = int(np.argmax(is_perf))
        # OOS 에서 best 전략의 상대 순위 (1..N)
        rank = int((oos_perf <= oos_perf[best]).sum())
        omega = rank / (N + 1)
        omega = min(max(omega, 1e-6), 1 - 1e-6)
        logits.append(np.log(omega / (1 - omega)))

    logits = np.array(logits)
    return float((logits < 0).mean())


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(7)

    print("=== 1) 비용 모델 ===")
    cm = KoreanCostModel()
    # 대형주, 1분봉 거래대금의 5% 참여, 1분 변동성 8bp 가정
    rt_eq = cm.round_trip_bps("eq", participation=0.05, sigma_bps=8.0)
    rt_fut = cm.round_trip_bps("fut", participation=0.05, sigma_bps=8.0)
    print(f"현물 왕복비용 : {rt_eq:.1f} bp  (수수료6 + 거래세20 + 슬리피지)")
    print(f"선물 왕복비용 : {rt_fut:.1f} bp")
    print(f"-> 현물 일중 회전 전략은 트레이드당 최소 {rt_eq:.0f}bp 를 이겨야 함\n")

    print("=== 2) Deflated Sharpe Ratio ===")
    # 일봉 5년치(1260). per-period SR 기준.
    strong = rng.normal(0.0025, 0.01, 1260)   # 강한 알파 (annualized ~4)
    noise = rng.normal(0.0, 0.01, 1260)        # 순수 노이즈
    SRV = 0.004  # 시도들 간 per-period 샤프 분산 (전역 시도원장에서 추정)
    for name, r in [("강한 알파", strong), ("노이즈 ", noise)]:
        psr = probabilistic_sharpe_ratio(r, 0.0)
        dsr_lo = deflated_sharpe_ratio(r, n_trials=100, sr_variance=SRV)
        dsr_hi = deflated_sharpe_ratio(r, n_trials=100_000, sr_variance=SRV)
        print(f"{name} | per-period SR={sharpe(r):+.3f} | PSR={psr:.3f} | "
              f"DSR(N=100)={dsr_lo:.3f} | DSR(N=10만)={dsr_hi:.3f}")
    print("-> 같은 알파도 시도(N)가 늘수록 통과 기준이 올라감. 노이즈는 어디서도 통과 못함.\n")

    print("=== 3) PBO (CSCV) ===")
    T, N = 2000, 50
    # 단일 행렬 PBO 는 분산이 커서, 노이즈는 여러 시드 평균으로 0.5 수렴을 확인
    pbos = []
    for s in range(8):
        g = np.random.default_rng(100 + s)
        pbos.append(pbo_cscv(g.normal(0, 0.01, (T, N)), 16))
    M_real = rng.normal(0, 0.01, (T, N))
    M_real[:, 0] += 0.0015                      # 1개만 지속적 알파 심기
    print(f"전부 노이즈 (8시드 평균) : PBO = {np.mean(pbos):.3f}  (0.5 근처여야 정상)")
    print(f"1개 지속 알파            : PBO = {pbo_cscv(M_real, 16):.3f}  (0 근처여야 정상)")
