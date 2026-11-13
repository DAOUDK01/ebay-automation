"""eBay REST APIs: Browse (competitor search) and Taxonomy (allowed item specifics)."""
from __future__ import annotations

import logging
import re
import time

import requests

from .ebay_auth import EbayAuth

log = logging.getLogger(__name__)
BASE = "https://api.ebay.com"


class RestClient:
    def __init__(self, auth: EbayAuth, marketplace_id: str = "EBAY_US"):
        self.auth = auth
        self.marketplace_id = marketplace_id
        self._tree_id: str | None = None
        self._aspects_cache: dict[str, list[dict]] = {}

    def _get(self, path: str, params: dict | None = None) -> dict:
        for attempt in range(1, 4):
            r = requests.get(BASE + path, params=params, timeout=30, headers={
                "Authorization": f"Bearer {self.auth.app_token()}",
                "X-EBAY-C-MARKETPLACE-ID": self.marketplace_id,
            })
            if r.status_code == 429 or r.status_code >= 500:
                log.warning("GET %s -> %s, retry %d", path, r.status_code, attempt)
                time.sleep(15 * attempt)
                continue
            if r.status_code == 204:
                return {}
            if r.status_code != 200:
                raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:400]}")
            return r.json()
        raise RuntimeError(f"GET {path} failed after retries")

    # ---------- Taxonomy ----------
    def category_tree_id(self) -> str:
        if self._tree_id is None:
            j = self._get("/commerce/taxonomy/v1/get_default_category_tree_id",
                          {"marketplace_id": self.marketplace_id})
            self._tree_id = j["categoryTreeId"]
        return self._tree_id

    def aspects_for_category(self, category_id: str) -> list[dict]:
        if category_id in self._aspects_cache:
            return self._aspects_cache[category_id]
        j = self._get(f"/commerce/taxonomy/v1/category_tree/{self.category_tree_id()}"
                      "/get_item_aspects_for_category", {"category_id": category_id})
        aspects = []
        for a in j.get("aspects", []):
            c = a.get("aspectConstraint", {})
            aspects.append({
                "name": a.get("localizedAspectName"),
                "required": bool(c.get("aspectRequired")),
                "usage": c.get("aspectUsage", "OPTIONAL"),
                "mode": c.get("aspectMode", "FREE_TEXT"),
                "multi": c.get("itemToAspectCardinality") == "MULTI",
                "max_length": c.get("aspectMaxLength"),
                "values": [v.get("localizedValue") for v in a.get("aspectValues", [])],
            })
        self._aspects_cache[category_id] = aspects
        return aspects

    # ---------- Browse ----------
    def search(self, q: str, category_id: str = "", condition_id: str = "",
               exclude_seller: str = "", limit: int = 15) -> list[dict]:
        filters = ["buyingOptions:{FIXED_PRICE}", "itemLocationCountry:US"]
        if condition_id:
            filters.append(f"conditionIds:{{{condition_id}}}")
        if exclude_seller:
            filters.append(f"excludeSellers:{{{exclude_seller}}}")
        params = {"q": q[:100], "limit": str(limit), "filter": ",".join(filters)}
        if category_id:
            params["category_ids"] = category_id
        j = self._get("/buy/browse/v1/item_summary/search", params)
        out = []
        for s in j.get("itemSummaries", []):
            ship = None
            opts = s.get("shippingOptions") or []
            if opts and opts[0].get("shippingCost"):
                ship = float(opts[0]["shippingCost"].get("value", 0))
            seller = s.get("seller", {})
            out.append({
                "title": s.get("title"),
                "price": float(s.get("price", {}).get("value", 0)),
                "shipping": ship,
                "condition": s.get("condition"),
                "seller_feedback": seller.get("feedbackScore"),
                "seller_positive_pct": seller.get("feedbackPercentage"),
                "top_rated": s.get("topRatedBuyingExperience", False),
            })
        return out

    def competitors_for(self, item: dict, exclude_seller: str = "", limit: int = 15) -> tuple[str, list[dict]]:
        """Try MPN/part number first (most precise), then shortened title."""
        specs = item.get("item_specifics", {})
        queries = []
        for key in ("Manufacturer Part Number", "MPN", "Interchange Part Number", "OE/OEM Part Number"):
            if specs.get(key) and specs[key][0].lower() not in ("does not apply", "n/a", "na"):
                queries.append(specs[key][0])
                break
        words = re.sub(r"[^\w\s\-/.]", " ", item["title"]).split()
        queries += [" ".join(words[:8]), " ".join(words[:5])]
        res: list[dict] = []
        used = ""
        for q in queries:
            if not q.strip():
                continue
            try:
                res = self.search(q, item.get("category_id", ""), item.get("condition_id", ""),
                                  exclude_seller, limit)
            except RuntimeError as e:
                log.warning("competitor search failed for %r: %s", q, e)
                res = []
            used = q
            if len(res) >= 3:
                break
        return used, res
