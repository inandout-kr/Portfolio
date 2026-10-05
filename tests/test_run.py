"""실데이터 실행 CLI 테스트 — 키/네트워크 없이 (CSV·LLM·DART 모두 주입/임시파일)."""
import csv
import json

import numpy as np
import pytest

import kairos_run
from kairos_harness import TrialLedger


def _write_csv(path, n=300, seed=3):
    rng = np.random.default_rng(seed)
    closes = 100 * np.exp(np.cumsum(rng.normal(0.001, 0.01, n)))
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["시가", "고가", "저가", "종가", "거래대금", "regime"])
        for i, c in enumerate(closes):
            w.writerow([f"{c:.2f}", f"{c * 1.01:.2f}", f"{c * 0.99:.2f}", f"{c:.2f}",
                        "10,000,000,000", "bull" if i % 2 else "bear"])
    return str(path)


def _args(argv):
    return kairos_run.build_parser().parse_args(argv)


def test_estimate_adv_uses_recent_days_times_bars_per_day():
    rows = [{"open": 1, "high": 1, "low": 1, "close": 1, "value": v}
            for v in [999] * 10 + [100] * 40]
    # 일봉: 최근 20행만 → 100
    assert kairos_run.estimate_adv_krw(rows, bars_per_day=1) == pytest.approx(100)
    # 2바/일: 최근 40행 평균 100 × 2
    assert kairos_run.estimate_adv_krw(rows, bars_per_day=2) == pytest.approx(200)


def test_check_runs_without_keys(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DART_API_KEY", raising=False)
    assert kairos_run.main(["--state-dir", str(tmp_path), "check"]) == 0
    out = capsys.readouterr().out
    assert "-- ANTHROPIC_API_KEY" in out and "N = 0" in out


def test_check_never_prints_key_value(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret-value")
    kairos_run.main(["--state-dir", str(tmp_path), "check"])
    assert "sk-secret-value" not in capsys.readouterr().out


def test_discover_persists_ledger_across_rounds(tmp_path):
    csv_path = _write_csv(tmp_path / "bars.csv")
    st = str(tmp_path / "state")
    kairos_run.main(["--state-dir", st, "discover", "--csv", csv_path,
                     "--n", "3", "--seed", "1", "--regime-col", "regime"])
    kairos_run.main(["--state-dir", st, "discover", "--csv", csv_path,
                     "--n", "2", "--seed", "2"])
    # 전역 시도 N 은 라운드를 넘어 누적 (§2 deflate 기준)
    assert TrialLedger(path=f"{st}/ledger.json").n_trials == 5
    lines = open(f"{st}/outcomes.jsonl", encoding="utf-8").read().splitlines()
    recs = [json.loads(x) for x in lines]
    assert len(recs) == 5
    assert all(r["expr"] and r["rationale"] and r["status"] for r in recs)


def test_discover_with_injected_llm(tmp_path):
    csv_path = _write_csv(tmp_path / "bars.csv")
    st = str(tmp_path / "state")
    fake_llm = lambda prompt: ("behavioral|과잉반응 후 추세 지속\n"
                               "risk_premium|펀더멘털 필요 → 스킵\n")
    args = _args(["--state-dir", st, "discover", "--csv", csv_path, "--n", "1"])
    kairos_run.cmd_discover(args, llm_fn=fake_llm)
    recs = [json.loads(x) for x in open(f"{st}/outcomes.jsonl", encoding="utf-8")]
    assert [r["origin"] for r in recs] == ["llm", "gp"]
    assert recs[0]["rationale"] == "과잉반응 후 추세 지속"


def test_discover_llm_without_key_fails_clearly(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    csv_path = _write_csv(tmp_path / "bars.csv")
    with pytest.raises(SystemExit, match="ANTHROPIC_API_KEY"):
        kairos_run.main(["--state-dir", str(tmp_path), "discover",
                         "--csv", csv_path, "--llm"])


def test_discover_rejects_too_few_bars(tmp_path):
    csv_path = _write_csv(tmp_path / "bars.csv", n=5)
    with pytest.raises(SystemExit, match="너무 적다"):
        kairos_run.main(["--state-dir", str(tmp_path), "discover", "--csv", csv_path])


def test_discover_capacity_fail_fast(tmp_path):
    csv_path = _write_csv(tmp_path / "bars.csv")
    st = str(tmp_path / "state")
    with pytest.raises(SystemExit, match="캐퍼시티"):
        kairos_run.main(["--state-dir", st, "discover", "--csv", csv_path,
                         "--target", "1e12"])
    assert TrialLedger(path=f"{st}/ledger.json").n_trials == 0


def test_discover_missing_regime_col(tmp_path):
    csv_path = _write_csv(tmp_path / "bars.csv")
    with pytest.raises(SystemExit, match="nope"):
        kairos_run.main(["--state-dir", str(tmp_path), "discover", "--csv", csv_path,
                         "--regime-col", "nope"])


def test_delistings_dedup_keeps_first_recorded_on(tmp_path):
    st = str(tmp_path)
    args = _args(["--state-dir", st, "delistings"])
    kairos_run.cmd_delistings(args, fetch_fn=lambda: [
        {"stock_code": "123456", "상장폐지일": "2026.05.20"}])
    path = f"{st}/delistings.json"
    first = json.load(open(path, encoding="utf-8"))["records"]
    kairos_run.cmd_delistings(args, fetch_fn=lambda: [
        {"stock_code": "123456", "delisting_date": "20260520"},
        {"stock_code": "7", "delisting_date": "20260601"}])
    recs = json.load(open(path, encoding="utf-8"))["records"]
    assert len(recs) == 2
    assert recs[0] == first[0]                    # 최초 수집 기록 보존 (PIT)
    assert recs[1]["ticker"] == "000007"


def test_delistings_from_json_file(tmp_path):
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps({"list": [{"stock_code": "123456",
                                         "delisting_date": "2026-05-20"}]}))
    kairos_run.main(["--state-dir", str(tmp_path), "delistings", "--from-json", str(raw)])
    recs = json.load(open(tmp_path / "delistings.json", encoding="utf-8"))["records"]
    assert recs[0]["ticker"] == "123456"


def test_delistings_without_key_fails_clearly(tmp_path, monkeypatch):
    monkeypatch.delenv("DART_API_KEY", raising=False)
    with pytest.raises(SystemExit, match="DART_API_KEY"):
        kairos_run.main(["--state-dir", str(tmp_path), "delistings"])
