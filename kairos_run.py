"""
kairos/run.py
=============
실데이터 실행 진입점 — 어댑터(시세/DART/LLM)를 통합 발굴 루프에 꽂는 CLI
(CLAUDE.md '다음 작업': 자격증명/데이터 연결 후 실데이터 발굴 라운드).

키·데이터는 사용자 환경에서 공급한다. 이 모듈은 그걸 받아 한 줄로 돌린다.

  python3 kairos_run.py check
      자격증명/패키지/영구 상태 점검 (키 값은 출력하지 않음).

  python3 kairos_run.py discover --csv bars.csv [--n 20] [--llm] [--bars-per-day 1]
      CSV 시세 → GP(+선택 LLM) 후보 생성 → 현실화 백테스트 → 통계 게이트 → 승격/처치.
      전역 시도원장(.kairos/ledger.json)이 세션을 넘어 누적 → DSR 의 N (§2).

  python3 kairos_run.py delistings [--from-json raw.json]
      DART 상폐 전향 수집(§8-3) → .kairos/delistings.json 에 중복 없이 누적.

영구 상태는 전부 --state-dir(기본 .kairos/, gitignore) 아래에 둔다.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from dataclasses import asdict
from datetime import date, datetime

import numpy as np

from kairos_data import bars_from_rows, closes_volumes, load_csv
from kairos_generator import Candidate, GeneticGenerator
from kairos_harness import TrialLedger
from kairos_pipeline import PROMOTED_PAPER, CandidateOutcome, DiscoveryPipeline
from kairos_promotion import PromotionPipeline
from kairos_simulator import RealizationSimulator
from kairos_supervisor import FailureLog, Supervisor

DEFAULT_STATE_DIR = ".kairos"
DEFAULT_LLM_PROMPT = "코스피200급 유동주, 분~일봉 기준 알파 가설을 5개 제안하라."
ADV_LOOKBACK_DAYS = 20


def _paths(state_dir: str) -> dict:
    return {
        "ledger": os.path.join(state_dir, "ledger.json"),
        "failures": os.path.join(state_dir, "failures.json"),
        "delistings": os.path.join(state_dir, "delistings.json"),
        "outcomes": os.path.join(state_dir, "outcomes.jsonl"),
    }


# ---------------------------------------------------------------------------
# 데이터 → 파이프라인 입력
# ---------------------------------------------------------------------------
def estimate_adv_krw(rows: list[dict], bars_per_day: int,
                     lookback_days: int = ADV_LOOKBACK_DAYS) -> float:
    """
    최근 lookback_days 일의 일평균 거래대금(ADV). 바당 거래대금(value)의 평균 ×
    하루 바 수. 캐퍼시티 점검(시뮬레이터)에 쓰므로 최근 구간만 본다.
    """
    values = [b.value for b in bars_from_rows(rows[-lookback_days * bars_per_day:])]
    if not values:
        raise ValueError("ADV 추정에 쓸 거래대금(value) 행이 없다")
    return float(np.mean(values)) * bars_per_day


def _regimes(rows: list[dict], col: str | None) -> np.ndarray | None:
    if not col:
        return None
    try:
        return np.asarray([r[col] for r in rows])
    except KeyError:
        raise SystemExit(f"레짐 컬럼 '{col}' 이 CSV 에 없다")


# ---------------------------------------------------------------------------
# 서브커맨드
# ---------------------------------------------------------------------------
def cmd_check(args) -> int:
    p = _paths(args.state_dir)
    try:
        import anthropic  # noqa: F401
        has_anthropic = True
    except ImportError:
        has_anthropic = False
    ledger = TrialLedger(path=p["ledger"])
    flog = FailureLog(path=p["failures"])
    n_delist = len(_load_delistings(p["delistings"]))

    def mark(ok: bool) -> str:
        return "OK " if ok else "-- "

    print("=== Kairos 실데이터 준비 상태 ===")
    print(f"  {mark(bool(os.environ.get('ANTHROPIC_API_KEY')))}ANTHROPIC_API_KEY  (LLM 가설 제안, discover --llm)")
    print(f"  {mark(has_anthropic)}anthropic 패키지")
    print(f"  {mark(bool(os.environ.get('DART_API_KEY')))}DART_API_KEY       (상폐 전향 수집, delistings)")
    print(f"\n상태 디렉터리: {args.state_dir}")
    print(f"  전역 시도원장 N = {ledger.n_trials}  (DSR 다중검정 보정)")
    print(f"  실패 모드 누적  = {flog.mode_counts() or '{}'}")
    print(f"  상폐 로그       = {n_delist}건")
    return 0


def _llm_candidates(prompt: str, llm_fn=None) -> list[Candidate]:
    from kairos_generator import LLMProposer
    if llm_fn is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise SystemExit("--llm 에는 ANTHROPIC_API_KEY 가 필요하다 (check 로 확인)")
        from kairos_llm import make_claude_llm_fn
        llm_fn = make_claude_llm_fn()
    return LLMProposer(llm_fn).propose(prompt)


def cmd_discover(args, llm_fn=None) -> int:
    p = _paths(args.state_dir)
    rows = load_csv(args.csv)
    if len(rows) < 2 * args.folds:
        raise SystemExit(f"바가 너무 적다({len(rows)}) — 워크포워드 {args.folds}구간에 부족")
    closes, volumes = closes_volumes(rows)
    regimes = _regimes(rows, args.regime_col)
    adv = args.adv if args.adv is not None else estimate_adv_krw(rows, args.bars_per_day)

    pipe = DiscoveryPipeline(
        generator=GeneticGenerator(rng=random.Random(args.seed), max_depth=args.max_depth),
        simulator=RealizationSimulator(),
        ledger=TrialLedger(path=p["ledger"]),
        promotion=PromotionPipeline(),
        supervisor=Supervisor(log=FailureLog(path=p["failures"])),
        n_folds=args.folds,
        instrument=args.instrument,
    )

    # 캐퍼시티는 후보와 무관(ADV/목표/참여율) → 후보마다 LIQUIDITY 실패를 쌓지 말고 먼저 중단
    if not pipe._capacity_ok(args.target, adv):
        raise SystemExit(f"캐퍼시티 부족: ADV≈{adv:,.0f} KRW 로 목표 {args.target:,.0f} KRW 를 "
                         f"5거래일 안에 소화 불가 — --target 을 줄이거나 더 유동적인 종목")

    cands: list[tuple[str, Candidate]] = []
    if args.llm or llm_fn is not None:
        cands += [("llm", c) for c in _llm_candidates(args.llm_prompt, llm_fn)]
    cands += [("gp", pipe.generator.make_candidate()) for _ in range(args.n)]

    round_id = datetime.now().strftime("%Y%m%dT%H%M%S")
    n_before = pipe.ledger.n_trials
    print(f"=== 발굴 라운드 {round_id} — {args.csv} ({len(rows)} bars) ===")
    print(f"  상품={args.instrument}  ADV≈{adv:,.0f} KRW  목표={args.target:,.0f} KRW  "
          f"후보={len(cands)}  원장 N(시작)={n_before}")
    print("  ⚠ 현재 상장 종목 데이터 = 생존편향 존재(§6). 백테스트 통과는 PAPER 진입일 뿐,"
          " 판정은 포워드가 한다(§8-4).\n")

    outcomes: list[tuple[str, Candidate, CandidateOutcome]] = []
    for i, (src, cand) in enumerate(cands):
        sid = f"{round_id}-{src}-{i:03d}"
        out = pipe.evaluate_one(cand, closes, volumes, regimes, adv, args.target, sid)
        outcomes.append((src, cand, out))
        dsr = out.detail.get("dsr")
        dsr_s = f"{dsr:.3f}" if isinstance(dsr, float) else "  -  "
        print(f"  {sid} [{out.category:14s}] {out.status:18s} "
              f"bt_sr={out.backtest_sharpe:+.3f} dsr={dsr_s}  {cand.tree}")

    _append_outcomes(p["outcomes"], round_id, args, outcomes)
    promoted = [o for _, _, o in outcomes if o.status == PROMOTED_PAPER]
    print(f"\n승격(PAPER) {len(promoted)}/{len(outcomes)}  |  "
          f"원장 N {n_before} → {pipe.ledger.n_trials}  |  "
          f"실패 모드 {pipe.supervisor.log.mode_counts()}")
    print(f"결과 기록: {p['outcomes']}")
    return 0


def _append_outcomes(path: str, round_id: str, args, outcomes) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for src, cand, out in outcomes:
            rec = {"round": round_id, "source": args.csv, "origin": src,
                   "expr": str(cand.tree), "rationale": cand.thesis.rationale,
                   **asdict(out)}
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")


def _load_delistings(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return list(json.load(f).get("records", []))


def cmd_delistings(args, fetch_fn=None) -> int:
    from kairos_dart import DartClient, collect_delistings
    p = _paths(args.state_dir)
    if fetch_fn is None:
        if args.from_json:
            def fetch_fn():
                with open(args.from_json, encoding="utf-8") as f:
                    data = json.load(f)
                return data.get("list", data) if isinstance(data, dict) else data
        else:
            try:
                fetch_fn = DartClient().fetch_delistings
            except RuntimeError as e:
                raise SystemExit(str(e))
    records = collect_delistings(fetch_fn, recorded_on=date.today())

    existing = _load_delistings(p["delistings"])
    seen = {(r["ticker"], r["delisted_on"]) for r in existing}
    added = 0
    for r in records:
        key = (r.ticker, r.delisted_on.isoformat())
        if key in seen:
            continue      # 최초 수집일(recorded_on)을 보존 = PIT
        seen.add(key)
        existing.append({"ticker": r.ticker, "delisted_on": key[1],
                         "recorded_on": r.recorded_on.isoformat()})
        added += 1
    os.makedirs(os.path.dirname(p["delistings"]) or ".", exist_ok=True)
    with open(p["delistings"], "w", encoding="utf-8") as f:
        json.dump({"records": existing}, f, ensure_ascii=False, indent=1)
    print(f"상폐 수집 {len(records)}건 → 신규 {added}건 (누적 {len(existing)}건) : {p['delistings']}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="kairos_run", description="Kairos 실데이터 실행")
    ap.add_argument("--state-dir", default=DEFAULT_STATE_DIR,
                    help="영구 상태(원장/실패로그/상폐로그) 디렉터리")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check", help="자격증명/상태 점검")

    d = sub.add_parser("discover", help="CSV 시세로 발굴 라운드 실행")
    d.add_argument("--csv", required=True, help="시세 CSV (open/high/low/close/value 헤더)")
    d.add_argument("--n", type=int, default=20, help="GP 후보 수")
    d.add_argument("--llm", action="store_true", help="Claude 가설 제안 후보 추가")
    d.add_argument("--llm-prompt", default=DEFAULT_LLM_PROMPT)
    d.add_argument("--instrument", choices=("eq", "fut"), default="eq")
    d.add_argument("--bars-per-day", type=int, default=1, help="일봉=1, 1분봉≈381")
    d.add_argument("--adv", type=float, default=None, help="ADV(KRW) 직접 지정")
    d.add_argument("--target", type=float, default=1_000_000_000, help="목표 포지션(KRW)")
    d.add_argument("--regime-col", default=None, help="레짐 라벨 컬럼명(선택)")
    d.add_argument("--folds", type=int, default=6, help="워크포워드 구간 수")
    d.add_argument("--max-depth", type=int, default=2)
    d.add_argument("--seed", type=int, default=None, help="생성기 시드(기본 무작위)")

    x = sub.add_parser("delistings", help="DART 상폐 전향 수집")
    x.add_argument("--from-json", default=None, help="DART 응답 JSON 파일(키 없이 적재)")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd == "discover":
        return cmd_discover(args)
    return cmd_delistings(args)


if __name__ == "__main__":
    sys.exit(main())
