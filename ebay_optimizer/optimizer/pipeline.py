"""Batch loop: sync -> pull batch -> improve each listing -> push batch -> next batch."""
from __future__ import annotations

import csv
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import guardrails
from .store import Store

log = logging.getLogger(__name__)

REPORT_COLUMNS = ["proposal_id", "item_id", "approve", "status", "old_title", "new_title",
                  "old_price", "new_price", "specifics_changes", "compatibility", "shipping_notes",
                  "other_notes", "confidence", "notes", "url"]


class BudgetExceeded(RuntimeError):
    pass


class Pipeline:
    def __init__(self, cfg, store: Store, trading, rest, claude):
        self.cfg, self.store, self.trading, self.rest, self.claude = cfg, store, trading, rest, claude
        self.costs = guardrails.load_costs(cfg.root / cfg.get("pricing", "costs_file", "costs.csv"))

    # ---------- sync ----------
    def sync_if_due(self, force: bool = False):
        last = self.store.get_meta("last_sync")
        hours = self.cfg.get("run", "resync_hours", 12)
        if not force and last and datetime.fromisoformat(last) > datetime.now(timezone.utc) - timedelta(hours=hours):
            return
        log.info("Syncing active listings from eBay...")
        items = self.trading.all_active_listings()
        self.store.sync_listings(items)
        log.info("Synced %d active listings", len(items))

    # ---------- one listing ----------
    def process_item(self, batch_id: int, item_id: str):
        budget = self.cfg.get("claude", "monthly_budget_usd", 90)
        if self.store.month_spend() >= budget:
            raise BudgetExceeded(f"Monthly Claude budget ${budget} reached")
        item = self.trading.get_item(item_id)
        if item["listing_type"] not in ("FixedPriceItem", "StoresFixedPrice"):
            self.store.add_proposal(batch_id, item_id, item, None, {}, ["auction - skipped"], "skipped")
            return
        aspects = self.rest.aspects_for_category(item["category_id"])
        query, comps = self.rest.competitors_for(
            item, self.cfg.get("ebay", "exclude_seller", ""), self.cfg.get("ebay", "competitor_count", 15))
        suggestion, cost = self.claude.suggest(item, aspects, comps)
        self.store.add_spend(cost)

        changes, notes = {}, [f"competitor query: {query!r} ({len(comps)} found)"]
        if self.cfg.get("title", "enabled", True):
            t, why = guardrails.check_title(item["title"], suggestion.get("title", ""))
            notes.append(f"title: {why}")
            if t:
                changes["title"] = t
        cost_basis = self.costs.get(item_id, self.costs.get(item.get("sku") or "\0"))
        p, why = guardrails.check_price(item, suggestion.get("recommended_price", 0),
                                        cost_basis, self.cfg.settings.get("pricing", {}))
        notes.append(f"price: {why}")
        if p:
            changes["price"] = p
        specs, snotes = guardrails.check_specifics(item, suggestion.get("item_specifics", []), aspects,
                                                   self.cfg.settings.get("specifics", {}))
        notes += snotes
        if specs:
            changes["item_specifics"] = specs
        compat, cnote = guardrails.check_compatibility(item, suggestion.get("compatibility", []),
                                                       self.cfg.settings.get("compatibility", {}))
        if cnote:
            notes.append(f"compatibility: {cnote}")
        if compat:
            changes["compatibility_add"] = compat

        status = "proposed" if changes else "no_change"
        self.store.add_proposal(batch_id, item_id, item, suggestion, changes, notes, status, cost=cost)
        log.info("%s: %s (%s) $%.3f", item_id, status, ", ".join(changes) or "-", cost)

    # ---------- one batch ----------
    def run_batch(self, limit: int | None = None, only_item: str | None = None) -> int | None:
        mode = self.cfg.get("run", "mode", "review")
        if only_item:
            ids = [only_item]
        else:
            self.sync_if_due()
            ids = self.store.next_batch(limit or self.cfg.get("run", "batch_size", 20),
                                        self.cfg.get("run", "cooldown_days", 21))
        if not ids:
            log.info("No listings due (all processed within cooldown).")
            return None
        batch_id = self.store.new_batch(mode)
        log.info("Batch %d: %d listings, mode=%s", batch_id, len(ids), mode)
        gap = self.cfg.get("run", "gap_between_listings_seconds", 20)
        for i, item_id in enumerate(ids):
            try:
                self.process_item(batch_id, item_id)
            except BudgetExceeded:
                raise
            except Exception as e:  # keep going with the rest of the batch
                log.exception("%s failed", item_id)
                self.store.add_proposal(batch_id, item_id, None, None, {}, [], "error", str(e))
            self.store.mark_processed(item_id)
            if i < len(ids) - 1:
                time.sleep(gap)

        report = self.write_report(batch_id)
        if mode == "auto":
            self.push_batch(batch_id)
            report = self.write_report(batch_id)
        else:
            log.info("Review mode: check %s, set approve=no on rows to skip, then run: python run.py push --batch %d",
                     report, batch_id)
        self.store.finish_batch(batch_id, str(report))
        return batch_id

    # ---------- push ----------
    def push_batch(self, batch_id: int, approvals: dict[int, dict] | None = None):
        gap = self.cfg.get("run", "gap_between_pushes_seconds", 5)
        for row in self.store.proposals(batch_id, "proposed"):
            changes = json.loads(row["changes_json"])
            if approvals is not None:
                a = approvals.get(row["id"])
                if a is None or a["approve"].strip().lower() not in ("yes", "y", "1", "true"):
                    self.store.set_proposal(row["id"], "rejected")
                    continue
                changes = self._apply_manual_edits(changes, json.loads(row["before_json"]), a)
            if not changes:
                self.store.set_proposal(row["id"], "no_change")
                continue
            try:
                warnings = self.trading.revise_item(row["item_id"], changes)
                self.store.set_proposal(row["id"], "pushed", "; ".join(w for w in warnings if w), changes)
                log.info("Pushed %s: %s", row["item_id"], ", ".join(changes))
            except Exception as e:
                log.error("Push failed %s: %s", row["item_id"], e)
                self.store.set_proposal(row["id"], "failed", str(e), changes)
            time.sleep(gap)

    def push_from_report(self, batch_id: int):
        path = self.report_path(batch_id)
        with open(path, newline="", encoding="utf-8-sig") as f:
            approvals = {int(r["proposal_id"]): r for r in csv.DictReader(f)}
        self.push_batch(batch_id, approvals)
        self.write_report(batch_id)

    @staticmethod
    def _apply_manual_edits(changes: dict, before: dict, row: dict) -> dict:
        """Lets you edit new_title / new_price in the review CSV before pushing."""
        changes = dict(changes)
        nt = (row.get("new_title") or "").strip()
        if nt and nt != changes.get("title"):
            t, _ = guardrails.check_title(before.get("title", ""), nt)
            if t and len(t) <= 80:
                changes["title"] = t
        elif not nt:
            changes.pop("title", None)
        np_ = (row.get("new_price") or "").strip()
        if np_:
            try:
                changes["price"] = round(float(np_), 2)
            except ValueError:
                pass
        else:
            changes.pop("price", None)
        return changes

    # ---------- report ----------
    def report_path(self, batch_id: int) -> Path:
        return self.cfg.reports_dir / f"batch_{batch_id:04d}.csv"

    def write_report(self, batch_id: int) -> Path:
        path = self.report_path(batch_id)
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=REPORT_COLUMNS)
            w.writeheader()
            for r in self.store.proposals(batch_id):
                before = json.loads(r["before_json"] or "{}")
                sug = json.loads(r["suggestion_json"] or "{}")
                ch = json.loads(r["changes_json"] or "{}")
                old_specs = before.get("item_specifics", {})
                spec_diff = [f"{k}: {v}" for k, v in (ch.get("item_specifics") or {}).items()
                             if old_specs.get(k) != v]
                comp = ch.get("compatibility_add") or [
                    {"Year": c["year"], "Make": c["make"], "Model": c["model"]} for c in sug.get("compatibility", [])]
                w.writerow({
                    "proposal_id": r["id"], "item_id": r["item_id"],
                    "approve": "yes" if r["status"] == "proposed" else "",
                    "status": r["status"] + (f" ({r['error']})" if r["error"] else ""),
                    "old_title": before.get("title", ""), "new_title": ch.get("title", ""),
                    "old_price": before.get("price", ""), "new_price": ch.get("price", ""),
                    "specifics_changes": " | ".join(spec_diff),
                    "compatibility": " | ".join(" ".join(c.values()) for c in comp[:30]),
                    "shipping_notes": sug.get("shipping_notes", ""),
                    "other_notes": " ".join(x for x in (sug.get("title_reason"), sug.get("price_reason"),
                                                         sug.get("other_notes")) if x),
                    "confidence": sug.get("confidence", ""),
                    "notes": (r["notes"] or "").replace("\n", " | "),
                    "url": before.get("url", ""),
                })
        return path

    # ---------- continuous loop ----------
    def in_active_hours(self) -> bool:
        window = self.cfg.get("run", "active_hours", "")
        if not window:
            return True
        start, end = window.split("-")
        t = datetime.now().strftime("%H:%M")
        return start <= t < end if start < end else (t >= start or t < end)

    def loop(self):
        gap_min = self.cfg.get("run", "gap_between_batches_minutes", 60)
        while True:
            if not self.in_active_hours():
                log.info("Outside active hours - sleeping 15 min")
                time.sleep(900)
                continue
            try:
                batch_id = self.run_batch()
            except BudgetExceeded as e:
                log.warning("%s - pausing 6 hours", e)
                time.sleep(6 * 3600)
                continue
            except Exception:
                log.exception("Batch failed - retrying after gap")
                batch_id = 0
            c = self.store.counts()
            log.info("Progress: %d of %d active listings processed at least once. Month spend $%.2f",
                     c["processed_ever"], c["active"], self.store.month_spend())
            if batch_id is None:
                log.info("Nothing due - sleeping 6 hours")
                time.sleep(6 * 3600)
                continue
            log.info("Sleeping %d min before next batch", gap_min)
            time.sleep(gap_min * 60)
