"""Offline end-to-end test with fake eBay + Claude (no network, no cost).
Run: python -m unittest tests.test_offline -v"""
import csv
import json
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

from optimizer import guardrails
from optimizer.config import Config
from optimizer.ebay_trading import TradingClient, _strip_ns
from optimizer.pipeline import Pipeline
from optimizer.store import Store

ROOT = Path(__file__).resolve().parent.parent

ITEM = {
    "item_id": "111", "title": "Honda Civic Brake Pad Set Front Ceramic", "subtitle": "", "sku": "BP-1",
    "listing_type": "FixedPriceItem", "category_id": "33572", "category_name": "Brake Pads",
    "condition_id": "1000", "condition": "New", "price": 40.0, "currency": "USD", "quantity": 5,
    "quantity_sold": 0, "watch_count": 1, "has_variations": False, "variation_names": [],
    "item_specifics": {"Brand": ["Acme"]}, "compatibility_count": 0, "compatibility_sample": [],
    "shipping": {}, "picture_count": 4, "description_text": "Fits 2016-2017 Honda Civic. Ceramic. MPN AC-555",
    "url": "https://www.ebay.com/itm/111",
}
ASPECTS = [
    {"name": "Brand", "required": True, "usage": "RECOMMENDED", "mode": "FREE_TEXT", "multi": False, "max_length": 65, "values": []},
    {"name": "Manufacturer Part Number", "required": False, "usage": "RECOMMENDED", "mode": "FREE_TEXT", "multi": False, "max_length": 65, "values": []},
    {"name": "Friction Material", "required": False, "usage": "RECOMMENDED", "mode": "SELECTION_ONLY", "multi": False, "max_length": 65, "values": ["Ceramic", "Semi-Metallic"]},
    {"name": "Placement on Vehicle", "required": False, "usage": "RECOMMENDED", "mode": "SELECTION_ONLY", "multi": True, "max_length": 65, "values": ["Front", "Rear"]},
]
SUGGESTION = {
    "title": "Acme Front Ceramic Brake Pad Set for 2016-2017 Honda Civic AC-555",
    "title_reason": "brand + MPN + fitment",
    "item_specifics": [
        {"name": "Manufacturer Part Number", "values": ["AC-555"], "source": "description"},
        {"name": "Friction Material", "values": ["ceramic"], "source": "title"},
        {"name": "Placement on Vehicle", "values": ["Front", "Middle"], "source": "title"},
        {"name": "Made Up Aspect", "values": ["x"], "source": "?"},
        {"name": "Brand", "values": ["Other"], "source": "?"},
    ],
    "recommended_price": 36.0, "price_reason": "competitors 35-38",
    "compatibility": [{"year": "2016", "make": "Honda", "model": "Civic", "trim": "", "engine": ""},
                      {"year": "2017", "make": "Honda", "model": "Civic", "trim": "", "engine": ""}],
    "shipping_notes": "", "other_notes": "", "confidence": "high",
}


class FakeTrading:
    def __init__(self):
        self.revised = []

    def all_active_listings(self):
        return [{"item_id": "111", "title": ITEM["title"], "sku": "BP-1", "price": 40.0,
                 "quantity_sold": 0, "watch_count": 1, "listing_type": "FixedPriceItem"}]

    def get_item(self, item_id):
        return json.loads(json.dumps(ITEM))

    def revise_item(self, item_id, changes):
        self.revised.append((item_id, changes))
        return []


class FakeRest:
    def aspects_for_category(self, cid):
        return ASPECTS

    def competitors_for(self, item, exclude_seller="", limit=15):
        return "AC-555", [{"title": "x", "price": 36.0, "shipping": 0}]


class FakeClaude:
    def suggest(self, item, aspects, comps):
        return json.loads(json.dumps(SUGGESTION)), 0.05


class OfflineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for d in ("data", "reports", "logs"):
            (self.tmp / d).mkdir()
        (self.tmp / "costs.csv").write_text("id,cost\nBP-1,20\n")
        settings = {
            "run": {"mode": "review", "batch_size": 5, "gap_between_listings_seconds": 0,
                    "gap_between_pushes_seconds": 0, "cooldown_days": 21},
            "claude": {"monthly_budget_usd": 90},
            "pricing": {"enabled": True, "max_change_pct": 5, "require_cost_for_decrease": True,
                        "min_margin_pct": 15, "fee_pct": 13.5, "costs_file": "costs.csv"},
            "specifics": {"enabled": True, "overwrite_existing": False},
            "compatibility": {"apply": False},
        }
        self.cfg = Config(settings, "id", "secret", "", "", root=self.tmp)
        self.trading = FakeTrading()
        self.p = Pipeline(self.cfg, Store(self.cfg.db_path), self.trading, FakeRest(), FakeClaude())

    def tearDown(self):
        self.p.store.db.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_review_then_push(self):
        bid = self.p.run_batch()
        rows = list(csv.DictReader(open(self.p.report_path(bid), encoding="utf-8-sig")))
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["new_title"], SUGGESTION["title"])
        self.assertEqual(float(r["new_price"]), 38.0)        # capped at -5%
        self.assertIn("Friction Material", r["specifics_changes"])
        self.assertNotIn("Made Up Aspect", r["specifics_changes"])
        self.assertNotIn("Brand", r["specifics_changes"])    # existing not overwritten
        self.assertEqual(self.trading.revised, [])          # review mode: nothing pushed yet

        # user edits the title in the CSV, then pushes
        r["new_title"] = "Acme Front Ceramic Brake Pads 2016-2017 Honda Civic AC-555"
        with open(self.p.report_path(bid), "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(r.keys())); w.writeheader(); w.writerow(r)
        self.p.push_from_report(bid)
        item_id, ch = self.trading.revised[0]
        self.assertEqual(ch["title"], r["new_title"])
        self.assertEqual(ch["item_specifics"]["Friction Material"], ["Ceramic"])
        self.assertNotIn("compatibility_add", ch)
        self.assertEqual(self.p.store.proposals(bid)[0]["status"], "pushed")
        # cooldown: nothing due now
        self.assertIsNone(self.p.run_batch())

    def test_auto_mode_pushes(self):
        self.cfg.settings["run"]["mode"] = "auto"
        self.p.run_batch()
        self.assertEqual(len(self.trading.revised), 1)


class GuardrailTests(unittest.TestCase):
    def test_title(self):
        self.assertIsNone(guardrails.check_title("a", "x" * 81)[0])
        self.assertIsNone(guardrails.check_title("Old title here", "L@@K Old title here!!")[0])

    def test_price_needs_cost_to_drop(self):
        item = dict(ITEM)
        self.assertIsNone(guardrails.check_price(item, 30, None, {"require_cost_for_decrease": True})[0])
        self.assertEqual(guardrails.check_price(item, 50, None, {"max_change_pct": 5})[0], 42.0)
        # floor: 30*1.15/0.865 = 39.88
        self.assertEqual(guardrails.check_price(item, 30, 30.0, {"max_change_pct": 5})[0], 39.88)

    def test_selection_only_multi(self):
        specs, notes = guardrails.check_specifics(ITEM, [{"name": "Placement on Vehicle", "values": ["Front", "Rear"]}],
                                                  ASPECTS, {})
        self.assertEqual(specs["Placement on Vehicle"], ["Front", "Rear"])


class XmlParseTest(unittest.TestCase):
    def test_get_item_parse(self):
        xml = """<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
        <Ack>Success</Ack><Item><ItemID>111</ItemID><Title>T</Title><ListingType>FixedPriceItem</ListingType>
        <PrimaryCategory><CategoryID>33572</CategoryID><CategoryName>Brake Pads</CategoryName></PrimaryCategory>
        <StartPrice currencyID="USD">40.0</StartPrice><Quantity>5</Quantity>
        <SellingStatus><QuantitySold>2</QuantitySold></SellingStatus>
        <ItemSpecifics><NameValueList><Name>Brand</Name><Value>Acme</Value></NameValueList></ItemSpecifics>
        <ItemCompatibilityList><Compatibility><NameValueList/><NameValueList><Name>Year</Name><Value>2016</Value></NameValueList>
        <NameValueList><Name>Make</Name><Value>Honda</Value></NameValueList></Compatibility></ItemCompatibilityList>
        <Description>&lt;p&gt;Fits Civic&lt;/p&gt;</Description></Item></GetItemResponse>"""
        tc = TradingClient(auth=None)
        with mock.patch.object(tc, "call", return_value=_strip_ns(ET.fromstring(xml))):
            it = tc.get_item("111")
        self.assertEqual(it["price"], 40.0)
        self.assertEqual(it["item_specifics"], {"Brand": ["Acme"]})
        self.assertEqual(it["compatibility_sample"], [{"Year": "2016", "Make": "Honda"}])
        self.assertEqual(it["description_text"], "Fits Civic")
        self.assertEqual(it["quantity_sold"], 2)


if __name__ == "__main__":
    unittest.main()
