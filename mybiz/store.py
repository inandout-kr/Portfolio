"""
mybiz/store.py
==============
영구 저장 — SQLite(원본 거래·수동 분류) + config.json(규칙·예산·기초잔액).

기본 위치는 ./.mybiz/ (환경변수 MYBIZ_HOME 로 변경). 개인 금융 데이터이므로
.gitignore 에 포함되어 있다. 원본 거래는 내용 기반 ID 로 중복 없이 쌓인다.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import date
from pathlib import Path

from .classify import Rule, classify
from .model import JournalEntry, RawTxn
from .reports import opening_entry

DEFAULT_CONFIG = {
    "opening_date": "2026-01-01",
    "opening_balances": {},
    "transfer_window_days": 2,
    "rules": [
        {"keyword": "급여", "account": "수익:근로소득", "direction": "in"},
        {"keyword": "이자", "account": "수익:영업외:이자", "direction": "in"},
        {"keyword": "배당", "account": "수익:영업외:배당", "direction": "in"},
        {"keyword": "월세", "account": "비용:고정:주거", "direction": "out"},
        {"keyword": "관리비", "account": "비용:고정:주거", "direction": "out"},
        {"keyword": "통신", "account": "비용:고정:통신", "direction": "out"},
        {"keyword": "보험", "account": "비용:고정:보험", "direction": "out"},
        {"keyword": "넷플릭스", "account": "비용:고정:구독", "direction": "out"},
        {"keyword": "유튜브", "account": "비용:고정:구독", "direction": "out"},
        {"keyword": "배달의민족", "account": "비용:변동:식비", "direction": "out"},
        {"keyword": "쿠팡이츠", "account": "비용:변동:식비", "direction": "out"},
        {"keyword": "스타벅스", "account": "비용:변동:식비", "direction": "out"},
        {"keyword": "편의점", "account": "비용:변동:식비", "direction": "out"},
        {"keyword": "택시", "account": "비용:변동:교통", "direction": "out"},
        {"keyword": "교통", "account": "비용:변동:교통", "direction": "out"},
        {"keyword": "쿠팡", "account": "비용:변동:쇼핑", "direction": "out"},
        {"keyword": "병원", "account": "비용:변동:의료", "direction": "out"},
        {"keyword": "약국", "account": "비용:변동:의료", "direction": "out"},
    ],
    "budget": {
        "비용:변동:식비": 600000,
        "비용:변동:쇼핑": 300000,
    },
}


def home() -> Path:
    return Path(os.environ.get("MYBIZ_HOME", ".mybiz"))


class Store:
    def __init__(self, root: Path | str | None = None):
        self.root = Path(root) if root else home()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "ledger.db")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS txns (
                id TEXT PRIMARY KEY, date TEXT NOT NULL, amount INTEGER NOT NULL,
                description TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS overrides (txn_id TEXT PRIMARY KEY, account TEXT NOT NULL);
        """)
        self.config_path = self.root / "config.json"
        if not self.config_path.exists():
            self.save_config(DEFAULT_CONFIG)

    # --- config -------------------------------------------------------
    def config(self) -> dict:
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def save_config(self, cfg: dict) -> None:
        self.config_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    def rules(self) -> list[Rule]:
        return [Rule(**r) for r in self.config().get("rules", [])]

    def add_rule(self, keyword: str, account: str, direction: str = "any") -> None:
        Rule(keyword, account, direction)  # 검증
        cfg = self.config()
        # 새 규칙이 기존 일반 규칙보다 먼저 매칭되도록 앞에 넣는다
        cfg["rules"].insert(0, {"keyword": keyword, "account": account, "direction": direction})
        self.save_config(cfg)

    # --- txns ---------------------------------------------------------
    def add_txns(self, txns: list[RawTxn]) -> int:
        """새로 들어간 건수 반환 (이미 있는 ID 는 무시)."""
        before = self.db.total_changes
        self.db.executemany(
            "INSERT OR IGNORE INTO txns VALUES (?,?,?,?,?,?)",
            [(t.id, t.date.isoformat(), t.amount, t.description, t.source, t.seq) for t in txns])
        self.db.commit()
        return self.db.total_changes - before

    def txns(self) -> list[RawTxn]:
        rows = self.db.execute(
            "SELECT date, amount, description, source, seq FROM txns ORDER BY date, id")
        return [RawTxn(date.fromisoformat(d), a, desc, s, q) for d, a, desc, s, q in rows]

    def set_override(self, txn_id: str, account: str) -> None:
        if not self.db.execute("SELECT 1 FROM txns WHERE id=?", (txn_id,)).fetchone():
            raise KeyError(f"거래 ID 없음: {txn_id}")
        Rule("", account)  # 계정명 검증
        self.db.execute("INSERT OR REPLACE INTO overrides VALUES (?,?)", (txn_id, account))
        self.db.commit()

    def overrides(self) -> dict[str, str]:
        return dict(self.db.execute("SELECT txn_id, account FROM overrides"))

    # --- journal ------------------------------------------------------
    def journal(self) -> list[JournalEntry]:
        cfg = self.config()
        entries = classify(self.txns(), self.rules(), self.overrides(),
                           cfg.get("transfer_window_days", 2))
        opening = opening_entry(cfg.get("opening_balances", {}),
                                date.fromisoformat(cfg.get("opening_date", "2000-01-01")))
        return ([opening] if opening else []) + entries
