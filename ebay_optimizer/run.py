"""eBay listing optimizer.

  python run.py check                 test eBay + Claude credentials
  python run.py sync                  pull all active listings into the local database
  python run.py once [--limit 5]      process ONE batch (good for testing)
  python run.py once --item 1234567   process a single listing
  python run.py push --batch 3        push approved rows of a reviewed batch to eBay
  python run.py loop                  run forever: batch -> push (auto mode) -> gap -> next batch
  python run.py status                progress and Claude spend this month
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

from optimizer.config import load_config
from optimizer.ebay_auth import EbayAuth
from optimizer.ebay_rest import RestClient
from optimizer.ebay_trading import TradingClient
from optimizer.pipeline import Pipeline
from optimizer.store import Store


def setup_logging(cfg):
    fmt = "%(asctime)s %(levelname)s %(message)s"
    logging.basicConfig(level=logging.INFO, format=fmt, handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(cfg.logs_dir / "optimizer.log", encoding="utf-8"),
    ])
    logging.getLogger("httpx").setLevel(logging.WARNING)


def build(cfg):
    from optimizer.claude_optimizer import ClaudeOptimizer
    auth = EbayAuth(cfg.ebay_client_id, cfg.ebay_client_secret, cfg.ebay_refresh_token)
    trading = TradingClient(auth, cfg.get("ebay", "site_id", 0))
    rest = RestClient(auth, cfg.get("ebay", "marketplace_id", "EBAY_US"))
    claude = ClaudeOptimizer(cfg.get("claude", "model", "claude-opus-5-5"),
                             cfg.get("claude", "effort", "medium"),
                             cfg.get("claude", "input_price_per_mtok", 4.0),
                             cfg.get("claude", "output_price_per_mtok", 20.0))
    store = Store(cfg.db_path)
    return Pipeline(cfg, store, trading, rest, claude)


def main():
    ap = argparse.ArgumentParser(description="eBay listing optimizer")
    ap.add_argument("command", choices=["check", "sync", "once", "push", "loop", "status"])
    ap.add_argument("--limit", type=int)
    ap.add_argument("--item")
    ap.add_argument("--batch", type=int)
    args = ap.parse_args()

    cfg = load_config()
    setup_logging(cfg)
    log = logging.getLogger("run")

    if args.command == "check":
        auth = EbayAuth(cfg.ebay_client_id, cfg.ebay_client_secret, cfg.ebay_refresh_token)
        auth.user_token(); log.info("eBay user token: OK")
        auth.app_token(); log.info("eBay app token: OK")
        items, pages = TradingClient(auth).active_listings_page(1, 5)
        log.info("Trading API OK - sample listings: %s", [i["title"] for i in items])
        log.info("Taxonomy OK - tree id %s", RestClient(auth).category_tree_id())
        log.info("ANTHROPIC_API_KEY set: %s", bool(os.getenv("ANTHROPIC_API_KEY")))
        return

    p = build(cfg)
    if args.command == "sync":
        p.sync_if_due(force=True)
    elif args.command == "once":
        bid = p.run_batch(limit=args.limit, only_item=args.item)
        if bid:
            log.info("Report: %s", p.report_path(bid))
    elif args.command == "push":
        bid = args.batch or p.store.last_batch_id()
        if not bid:
            log.error("No batch to push"); return
        p.push_from_report(bid)
        log.info("Done. Updated report: %s", p.report_path(bid))
    elif args.command == "loop":
        p.loop()
    elif args.command == "status":
        c = p.store.counts()
        log.info("Active listings: %d | processed at least once: %d | Claude spend this month: $%.2f",
                 c["active"], c["processed_ever"], p.store.month_spend())


if __name__ == "__main__":
    main()
