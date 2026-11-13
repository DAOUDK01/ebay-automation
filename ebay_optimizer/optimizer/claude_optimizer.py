"""Asks Claude for listing improvements as structured JSON. Claude only SUGGESTS;
guardrails.py decides what is actually allowed to change."""
from __future__ import annotations

import json
import logging

import anthropic

log = logging.getLogger(__name__)

# Models that accept server-side refusal fallbacks ("default" routing).
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"}

SYSTEM_PROMPT = """You are an expert eBay listing optimizer for a US eBay store. For each listing you
receive the current listing data, the eBay category's item specifics (aspects) with their
allowed values, and a sample of competing active fixed-price listings. Suggest improvements
that raise search relevance (Cassini) and conversion.

Title rules:
- Max 80 characters. Use the space well: Brand + Product type + key attributes (model, part
  number, size, color, compatibility such as years/make/model, quantity).
- Put the words buyers actually search for first. No ALL CAPS words except brands/acronyms
  that are normally capitalized, no keyword stuffing, no "L@@K", no emojis, no symbols like
  ! or * , no unrelated brand names, no words like "best" or "cheap".
- Never claim anything the listing data does not support (do not invent part numbers,
  sizes, compatibility, or brand). If the current title is already strong, return it unchanged.

Item specifics rules:
- Fill in MISSING aspects, prioritising REQUIRED then RECOMMENDED ones.
- Only use facts found in the title, description, existing specifics, or that are certain from
  them. If unknown, leave the aspect out. Never guess. "Does Not Apply" only for Brand/MPN when
  the item is genuinely unbranded / has no part number.
- For SELECTION_ONLY aspects you must use one of the allowed values exactly as written.
- Use the exact aspect name as given.

Pricing rules:
- Compare against competitors with the same condition and the closest match (total price =
  price + shipping). Ignore listings that are clearly a different product, a lot/bundle, or
  parts-only.
- Recommend a price that is competitive for the item's quality and seller strength; you do
  not need to be cheapest. If too few true matches exist, recommend 0 (= keep current price).
- Explain briefly which competitor prices you based this on.

Compatibility (vehicle parts only):
- Suggest compatibility rows ONLY when the listing text/specifics explicitly state fitment
  (e.g. "fits 2015-2018 Honda Civic"). Expand year ranges into one row per year. Never infer
  fitment from general knowledge. Otherwise return an empty list.

Shipping: you cannot change shipping directly; give short advice in shipping_notes if the
handling time or shipping cost looks uncompetitive versus competitors, else empty string.

Return JSON only, matching the schema."""

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "title_reason": {"type": "string"},
        "item_specifics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "values": {"type": "array", "items": {"type": "string"}},
                    "source": {"type": "string"},
                },
                "required": ["name", "values", "source"],
                "additionalProperties": False,
            },
        },
        "recommended_price": {"type": "number"},
        "price_reason": {"type": "string"},
        "compatibility": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "year": {"type": "string"},
                    "make": {"type": "string"},
                    "model": {"type": "string"},
                    "trim": {"type": "string"},
                    "engine": {"type": "string"},
                },
                "required": ["year", "make", "model", "trim", "engine"],
                "additionalProperties": False,
            },
        },
        "shipping_notes": {"type": "string"},
        "other_notes": {"type": "string"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["title", "title_reason", "item_specifics", "recommended_price", "price_reason",
                 "compatibility", "shipping_notes", "other_notes", "confidence"],
    "additionalProperties": False,
}


def _aspects_for_prompt(aspects: list[dict], existing: dict) -> list[dict]:
    out = []
    for a in aspects:
        if a["name"] in existing:
            continue  # already filled
        if not a["required"] and a["usage"] != "RECOMMENDED":
            continue
        out.append({
            "name": a["name"],
            "required": a["required"],
            "mode": a["mode"],
            "multi_value": a["multi"],
            "allowed_values": a["values"][:60] if a["mode"] == "SELECTION_ONLY" else a["values"][:15],
        })
    return out


class ClaudeOptimizer:
    def __init__(self, model: str, effort: str = "medium",
                 input_price: float = 4.0, output_price: float = 20.0):
        self.client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
        self.model = model
        self.effort = effort
        self.input_price = input_price
        self.output_price = output_price

    def cost_usd(self, usage) -> float:
        inp = (usage.input_tokens or 0) + (getattr(usage, "cache_creation_input_tokens", 0) or 0) * 1.25 \
            + (getattr(usage, "cache_read_input_tokens", 0) or 0) * 0.1
        return inp / 1e6 * self.input_price + (usage.output_tokens or 0) / 1e6 * self.output_price

    def suggest(self, item: dict, aspects: list[dict], competitors: list[dict]) -> tuple[dict, float]:
        listing = {k: item[k] for k in (
            "title", "subtitle", "sku", "category_name", "condition", "price", "currency",
            "quantity", "quantity_sold", "watch_count", "has_variations", "item_specifics",
            "compatibility_count", "compatibility_sample", "shipping", "picture_count",
            "description_text")}
        payload = {
            "listing": listing,
            "missing_aspects": _aspects_for_prompt(aspects, item["item_specifics"]),
            "competitors": competitors,
        }
        kwargs = dict(
            model=self.model,
            max_tokens=16000,
            output_config={"effort": self.effort,
                           "format": {"type": "json_schema", "schema": SCHEMA}},
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
        )
        if self.model in FALLBACK_MODELS:
            resp = self.client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
        else:
            resp = self.client.messages.create(**kwargs)

        cost = self.cost_usd(resp.usage)
        if resp.stop_reason == "refusal":
            raise RuntimeError("Claude declined this listing (refusal)")
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("Claude response was cut off (max_tokens)")
        text = next((b.text for b in resp.content if b.type == "text"), "")
        return json.loads(text), cost
