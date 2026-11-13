"""eBay Trading API (XML): list active listings, read full listing, revise listing.
Trading API is used because it works for ALL listings, including ones created in Seller Hub."""
from __future__ import annotations

import logging
import re
import time
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

import requests

from .ebay_auth import EbayAuth

log = logging.getLogger(__name__)
ENDPOINT = "https://api.ebay.com/ws/api.dll"
NS = "urn:ebay:apis:eBLBaseComponents"
COMPAT_LEVEL = "1349"


def _strip_ns(root: ET.Element) -> ET.Element:
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def _t(el, path, default=""):
    if el is None:
        return default
    found = el.find(path)
    return found.text.strip() if found is not None and found.text else default


def _html_to_text(html: str, limit: int = 2500) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;|&#160;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


class EbayApiError(RuntimeError):
    pass


class TradingClient:
    def __init__(self, auth: EbayAuth, site_id: int = 0):
        self.auth = auth
        self.site_id = site_id

    def call(self, name: str, inner_xml: str, retries: int = 3) -> ET.Element:
        body = (f'<?xml version="1.0" encoding="utf-8"?>'
                f'<{name}Request xmlns="{NS}">'
                f"<ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>"
                f"{inner_xml}</{name}Request>")
        for attempt in range(1, retries + 1):
            headers = {
                "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
                "X-EBAY-API-CALL-NAME": name,
                "X-EBAY-API-SITEID": str(self.site_id),
                "X-EBAY-API-IAF-TOKEN": self.auth.user_token(),
                "Content-Type": "text/xml",
            }
            try:
                r = requests.post(ENDPOINT, data=body.encode("utf-8"), headers=headers, timeout=60)
            except requests.RequestException as e:
                log.warning("%s network error (%s), retry %d", name, e, attempt)
                time.sleep(10 * attempt)
                continue
            if r.status_code >= 500:
                log.warning("%s HTTP %s, retry %d", name, r.status_code, attempt)
                time.sleep(10 * attempt)
                continue
            root = _strip_ns(ET.fromstring(r.content))
            ack = _t(root, "Ack")
            if ack in ("Success", "Warning"):
                for err in root.findall("Errors"):
                    log.info("%s warning: %s", name, _t(err, "LongMessage"))
                return root
            msgs = [f"[{_t(e, 'ErrorCode')}] {_t(e, 'LongMessage')}" for e in root.findall("Errors")
                    if _t(e, "SeverityCode") == "Error"]
            # 518 = call usage limit reached
            if any(m.startswith("[518]") for m in msgs):
                log.warning("eBay call limit reached - sleeping 30 min")
                time.sleep(1800)
                continue
            raise EbayApiError(f"{name} failed: {'; '.join(msgs) or r.text[:500]}")
        raise EbayApiError(f"{name} failed after {retries} attempts")

    # ---------- read ----------
    def active_listings_page(self, page: int, per_page: int = 200) -> tuple[list[dict], int]:
        root = self.call("GetMyeBaySelling", (
            "<ActiveList><Include>true</Include>"
            f"<Pagination><EntriesPerPage>{per_page}</EntriesPerPage>"
            f"<PageNumber>{page}</PageNumber></Pagination></ActiveList>"
            "<DetailLevel>ReturnAll</DetailLevel>"))
        active = root.find("ActiveList")
        if active is None:
            return [], 0
        pages = int(_t(active, "PaginationResult/TotalNumberOfPages", "0") or 0)
        items = []
        for it in active.findall("ItemArray/Item"):
            items.append({
                "item_id": _t(it, "ItemID"),
                "title": _t(it, "Title"),
                "sku": _t(it, "SKU"),
                "price": float(_t(it, "SellingStatus/CurrentPrice", "0") or 0),
                "quantity_sold": int(_t(it, "SellingStatus/QuantitySold", "0") or 0),
                "watch_count": int(_t(it, "WatchCount", "0") or 0),
                "listing_type": _t(it, "ListingType"),
            })
        return items, pages

    def all_active_listings(self) -> list[dict]:
        out, page = [], 1
        while True:
            items, pages = self.active_listings_page(page)
            out.extend(items)
            if page >= pages or not items:
                return out
            page += 1

    def get_item(self, item_id: str) -> dict:
        root = self.call("GetItem", (
            f"<ItemID>{escape(item_id)}</ItemID><DetailLevel>ReturnAll</DetailLevel>"
            "<IncludeItemSpecifics>true</IncludeItemSpecifics>"
            "<IncludeItemCompatibilityList>true</IncludeItemCompatibilityList>"
            "<IncludeWatchCount>true</IncludeWatchCount>"))
        it = root.find("Item")
        if it is None:
            raise EbayApiError(f"GetItem returned no item for {item_id}")

        specifics: dict[str, list[str]] = {}
        for nv in it.findall("ItemSpecifics/NameValueList"):
            name = _t(nv, "Name")
            if name:
                specifics[name] = [v.text.strip() for v in nv.findall("Value") if v.text]

        compat = []
        for c in it.findall("ItemCompatibilityList/Compatibility"):
            row = {_t(nv, "Name"): _t(nv, "Value") for nv in c.findall("NameValueList") if _t(nv, "Name")}
            if row:
                compat.append(row)

        variation_names = [_t(nv, "Name") for nv in it.findall("Variations/VariationSpecificsSet/NameValueList")]
        ship_opts = []
        for so in it.findall("ShippingDetails/ShippingServiceOptions"):
            ship_opts.append({
                "service": _t(so, "ShippingService"),
                "cost": _t(so, "ShippingServiceCost", "0"),
                "free": _t(so, "FreeShipping") == "true",
            })

        return {
            "item_id": item_id,
            "title": _t(it, "Title"),
            "subtitle": _t(it, "SubTitle"),
            "sku": _t(it, "SKU"),
            "listing_type": _t(it, "ListingType"),
            "category_id": _t(it, "PrimaryCategory/CategoryID"),
            "category_name": _t(it, "PrimaryCategory/CategoryName"),
            "condition_id": _t(it, "ConditionID"),
            "condition": _t(it, "ConditionDisplayName"),
            "price": float(_t(it, "StartPrice", "0") or 0),
            "currency": (it.find("StartPrice").get("currencyID") if it.find("StartPrice") is not None else "USD"),
            "quantity": int(_t(it, "Quantity", "0") or 0),
            "quantity_sold": int(_t(it, "SellingStatus/QuantitySold", "0") or 0),
            "watch_count": int(_t(it, "WatchCount", "0") or 0),
            "has_variations": it.find("Variations") is not None,
            "variation_names": variation_names,
            "item_specifics": specifics,
            "compatibility_count": len(compat),
            "compatibility_sample": compat[:25],
            "shipping": {
                "options": ship_opts,
                "dispatch_days": _t(it, "DispatchTimeMax"),
                "policy": _t(it, "SellerProfiles/SellerShippingProfile/ShippingProfileName"),
                "location": _t(it, "Location"),
            },
            "picture_count": len(it.findall("PictureDetails/PictureURL")),
            "description_text": _html_to_text(_t(it, "Description")),
            "url": _t(it, "ListingDetails/ViewItemURL"),
        }

    # ---------- write ----------
    def revise_item(self, item_id: str, changes: dict) -> list[str]:
        """changes keys (all optional): title, price, item_specifics (full dict name->[values]),
        compatibility_add (list of {name: value} rows). Returns warnings."""
        parts = [f"<ItemID>{escape(item_id)}</ItemID>"]
        if changes.get("title"):
            parts.append(f"<Title>{escape(changes['title'])}</Title>")
        if changes.get("price"):
            parts.append(f"<StartPrice>{changes['price']:.2f}</StartPrice>")
        if changes.get("item_specifics"):
            nvs = []
            for name, values in changes["item_specifics"].items():
                vals = "".join(f"<Value>{escape(v)}</Value>" for v in values if v)
                if vals:
                    nvs.append(f"<NameValueList><Name>{escape(name)}</Name>{vals}</NameValueList>")
            parts.append("<ItemSpecifics>" + "".join(nvs) + "</ItemSpecifics>")
        if changes.get("compatibility_add"):
            rows = []
            for row in changes["compatibility_add"]:
                nvs = "".join(f"<NameValueList><Name>{escape(k)}</Name><Value>{escape(v)}</Value></NameValueList>"
                              for k, v in row.items() if v)
                rows.append(f"<Compatibility>{nvs}</Compatibility>")
            parts.append("<ItemCompatibilityList><ReplaceAll>false</ReplaceAll>"
                         + "".join(rows) + "</ItemCompatibilityList>")
        root = self.call("ReviseFixedPriceItem", "<Item>" + "".join(parts) + "</Item>")
        return [_t(e, "LongMessage") for e in root.findall("Errors")]
