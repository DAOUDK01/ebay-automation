"""Hard rules in code (not in Claude) that decide which suggested edits are allowed."""
from __future__ import annotations

import csv
import re
from pathlib import Path

BANNED_TITLE = re.compile(r"(l@@k|wow|!!|\*|best\b|cheap\b|free shipping)", re.I)


def load_costs(path: Path) -> dict[str, float]:
    """costs.csv: columns `id` (ItemID or SKU) and `cost` (your landed cost incl. what you pay for shipping)."""
    costs: dict[str, float] = {}
    if not path.exists():
        return costs
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                costs[row["id"].strip()] = float(row["cost"])
            except (KeyError, ValueError):
                continue
    return costs


def check_title(old: str, new: str) -> tuple[str | None, str]:
    new = re.sub(r"\s+", " ", (new or "")).strip()
    if not new or new == old.strip():
        return None, "unchanged"
    if len(new) > 80:
        return None, f"rejected: {len(new)} chars > 80"
    if BANNED_TITLE.search(new):
        return None, "rejected: banned words/symbols"
    if len(new) < min(len(old), 80) * 0.7:
        return None, "rejected: much shorter than current title"
    return new, "ok"


def check_price(item: dict, suggested: float, cost: float | None, s: dict) -> tuple[float | None, str]:
    old = item["price"]
    if not s.get("enabled", True):
        return None, "pricing disabled"
    if item["has_variations"]:
        return None, "variation listing - price per variation not handled"
    if not suggested or suggested <= 0 or old <= 0:
        return None, "keep current"
    max_pct = s.get("max_change_pct", 5) / 100
    new = min(max(suggested, old * (1 - max_pct)), old * (1 + max_pct))
    new = round(new, 2)
    if abs(new - old) / old < 0.01:
        return None, "change < 1%, skipped"
    if new < old:
        if cost is None:
            if s.get("require_cost_for_decrease", True):
                return None, f"decrease to {new} needs cost data (costs.csv)"
        else:
            fee = s.get("fee_pct", 13.5) / 100
            margin = s.get("min_margin_pct", 15) / 100
            floor = round(cost * (1 + margin) / (1 - fee), 2)
            if new < floor:
                if old <= floor:
                    return None, f"already at/below floor {floor}"
                new = floor
    if s.get("min_price") and new < s["min_price"]:
        return None, f"below min_price {s['min_price']}"
    return new, f"{old} -> {new} (Claude suggested {suggested})"


def check_specifics(item: dict, suggested: list[dict], aspects: list[dict], s: dict) -> tuple[dict | None, list[str]]:
    """Returns the FULL new specifics dict (eBay replaces the whole set) or None if nothing changes."""
    if not s.get("enabled", True):
        return None, ["specifics disabled"]
    by_name = {a["name"].lower(): a for a in aspects}
    variation = {n.lower() for n in item.get("variation_names", [])}
    current = {k: list(v) for k, v in item["item_specifics"].items()}
    current_lower = {k.lower(): k for k in current}
    notes, changed = [], False
    for sug in suggested or []:
        name = (sug.get("name") or "").strip()
        values = [v.strip() for v in sug.get("values", []) if v and v.strip()]
        if not name or not values:
            continue
        a = by_name.get(name.lower())
        if a is None:
            notes.append(f"skip '{name}': not an aspect of this category")
            continue
        name = a["name"]
        if name.lower() in variation:
            continue
        if a["mode"] == "SELECTION_ONLY":
            allowed = {v.lower(): v for v in a["values"]}
            bad = [v for v in values if v.lower() not in allowed]
            if bad:
                notes.append(f"skip '{name}': value(s) {bad} not allowed")
                continue
            values = [allowed[v.lower()] for v in values]
        if not a["multi"]:
            values = values[:1]
        if a.get("max_length"):
            values = [v for v in values if len(v) <= a["max_length"]]
            if not values:
                continue
        existing_key = current_lower.get(name.lower())
        if existing_key:
            if not s.get("overwrite_existing", False) or current[existing_key] == values:
                continue
            notes.append(f"overwrite '{name}': {current[existing_key]} -> {values}")
            current[existing_key] = values
        else:
            notes.append(f"add '{name}': {values}")
            current[name] = values
        changed = True
    if len(current) > 45:  # eBay limit
        return None, notes + ["too many specifics, skipped"]
    return (current if changed else None), notes


def check_compatibility(item: dict, rows: list[dict], s: dict) -> tuple[list[dict] | None, str]:
    clean = []
    for r in rows or []:
        if not (r.get("year") and r.get("make") and r.get("model")):
            continue
        if not re.fullmatch(r"(19|20)\d\d", r["year"].strip()):
            continue
        row = {"Year": r["year"].strip(), "Make": r["make"].strip(), "Model": r["model"].strip()}
        if r.get("trim"):
            row["Trim"] = r["trim"].strip()
        if r.get("engine"):
            row["Engine"] = r["engine"].strip()
        clean.append(row)
    if not clean:
        return None, ""
    existing = {(c.get("Year"), c.get("Make"), c.get("Model")) for c in item.get("compatibility_sample", [])}
    clean = [c for c in clean if (c["Year"], c["Make"], c["Model"]) not in existing]
    if not clean:
        return None, "no new fitment rows"
    if not s.get("apply", False):
        return None, f"{len(clean)} fitment rows suggested (report only - compatibility.apply=false)"
    return clean[:100], f"add {len(clean[:100])} fitment rows"
