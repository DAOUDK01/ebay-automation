"""SQLite state: which listings exist, when each was last worked on, proposals, Claude spend."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
    item_id TEXT PRIMARY KEY, title TEXT, sku TEXT, price REAL, quantity_sold INTEGER,
    watch_count INTEGER, listing_type TEXT, active INTEGER DEFAULT 1,
    last_synced TEXT, last_processed TEXT
);
CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started TEXT, finished TEXT, mode TEXT, report TEXT
);
CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, item_id TEXT, created TEXT,
    before_json TEXT, suggestion_json TEXT, changes_json TEXT, notes TEXT,
    status TEXT, error TEXT, pushed TEXT, cost_usd REAL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS spend (month TEXT PRIMARY KEY, usd REAL);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # --- meta ---
    def get_meta(self, key: str, default: str = "") -> str:
        r = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return r["value"] if r else default

    def set_meta(self, key: str, value: str):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, value))
        self.db.commit()

    # --- listings ---
    def sync_listings(self, items: list[dict]):
        ts = now()
        self.db.execute("UPDATE listings SET active=0")
        for it in items:
            self.db.execute(
                """INSERT INTO listings (item_id,title,sku,price,quantity_sold,watch_count,listing_type,active,last_synced)
                   VALUES (?,?,?,?,?,?,?,1,?)
                   ON CONFLICT(item_id) DO UPDATE SET title=excluded.title, sku=excluded.sku,
                   price=excluded.price, quantity_sold=excluded.quantity_sold, watch_count=excluded.watch_count,
                   listing_type=excluded.listing_type, active=1, last_synced=excluded.last_synced""",
                (it["item_id"], it["title"], it["sku"], it["price"], it["quantity_sold"],
                 it["watch_count"], it["listing_type"], ts))
        self.db.commit()
        self.set_meta("last_sync", ts)

    def next_batch(self, size: int, cooldown_days: int) -> list[str]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=cooldown_days)).isoformat(timespec="seconds")
        rows = self.db.execute(
            """SELECT item_id FROM listings
               WHERE active=1 AND (listing_type IS NULL OR listing_type != 'Chinese')
                 AND (last_processed IS NULL OR last_processed < ?)
               ORDER BY last_processed IS NOT NULL, last_processed, quantity_sold, watch_count
               LIMIT ?""", (cutoff, size)).fetchall()
        return [r["item_id"] for r in rows]

    def mark_processed(self, item_id: str):
        self.db.execute("UPDATE listings SET last_processed=? WHERE item_id=?", (now(), item_id))
        self.db.commit()

    def counts(self) -> dict:
        r = self.db.execute("""SELECT COUNT(*) total, SUM(last_processed IS NOT NULL) done
                               FROM listings WHERE active=1""").fetchone()
        return {"active": r["total"] or 0, "processed_ever": r["done"] or 0}

    # --- batches / proposals ---
    def new_batch(self, mode: str) -> int:
        cur = self.db.execute("INSERT INTO batches (started, mode) VALUES (?,?)", (now(), mode))
        self.db.commit()
        return cur.lastrowid

    def finish_batch(self, batch_id: int, report: str):
        self.db.execute("UPDATE batches SET finished=?, report=? WHERE id=?", (now(), report, batch_id))
        self.db.commit()

    def last_batch_id(self) -> int | None:
        r = self.db.execute("SELECT MAX(id) m FROM batches").fetchone()
        return r["m"]

    def add_proposal(self, batch_id: int, item_id: str, before: dict | None, suggestion: dict | None,
                     changes: dict, notes: list[str], status: str, error: str = "", cost: float = 0.0) -> int:
        cur = self.db.execute(
            """INSERT INTO proposals (batch_id,item_id,created,before_json,suggestion_json,changes_json,
               notes,status,error,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (batch_id, item_id, now(), json.dumps(before or {}), json.dumps(suggestion or {}),
             json.dumps(changes), "\n".join(notes), status, error, cost))
        self.db.commit()
        return cur.lastrowid

    def proposals(self, batch_id: int, status: str | None = None) -> list[sqlite3.Row]:
        q = "SELECT * FROM proposals WHERE batch_id=?"
        args: tuple = (batch_id,)
        if status:
            q += " AND status=?"
            args += (status,)
        return self.db.execute(q + " ORDER BY id", args).fetchall()

    def set_proposal(self, pid: int, status: str, error: str = "", changes: dict | None = None):
        if changes is not None:
            self.db.execute("UPDATE proposals SET changes_json=? WHERE id=?", (json.dumps(changes), pid))
        self.db.execute("UPDATE proposals SET status=?, error=?, pushed=? WHERE id=?",
                        (status, error, now() if status == "pushed" else None, pid))
        self.db.commit()

    # --- spend ---
    def add_spend(self, usd: float):
        m = datetime.now(timezone.utc).strftime("%Y-%m")
        self.db.execute("INSERT INTO spend VALUES (?,?) ON CONFLICT(month) DO UPDATE SET usd=usd+?", (m, usd, usd))
        self.db.commit()

    def month_spend(self) -> float:
        m = datetime.now(timezone.utc).strftime("%Y-%m")
        r = self.db.execute("SELECT usd FROM spend WHERE month=?", (m,)).fetchone()
        return r["usd"] if r else 0.0
