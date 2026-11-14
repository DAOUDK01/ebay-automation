/** Asks Claude for listing improvements as structured JSON.
 *  Claude only SUGGESTS - guardrails.ts decides what is actually allowed to change. */
import Anthropic from "@anthropic-ai/sdk";
import type { Aspect, Competitor, EbayItem } from "./ebay/types";
import type { FitmentEvidence } from "./fitment";

/** Models that accept server-side refusal fallbacks ("default" routing). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export interface ClaudeSuggestion {
  title: string;
  title_reason: string;
  item_specifics: { name: string; values: string[]; source: string }[];
  recommended_price: number;
  price_reason: string;
  compatibility: {
    year: string;
    make: string;
    model: string;
    trim: string;
    engine: string;
    source: "listing_text" | "part_number_knowledge";
    confidence: "low" | "medium" | "high";
  }[];
  shipping_notes: string;
  other_notes: string;
  confidence: "low" | "medium" | "high";
}

export const SYSTEM_PROMPT = `You are an expert eBay listing optimizer for an eBay store. For each listing you
receive the current listing data, the eBay category's missing item specifics (aspects) with their
allowed values, and a sample of competing active fixed-price listings. Suggest improvements
that raise search relevance (Cassini) and conversion.

Title rules:
- Max 80 characters. Use the space well: Brand + Product type + key attributes (model, part
  number, size, color, compatibility such as years/make/model, quantity).
- Put the words buyers actually search for first. No ALL CAPS words except brands/acronyms
  that are normally capitalized, no keyword stuffing, no "L@@K", no emojis, no symbols like
  ! or *, no unrelated brand names, no words like "best" or "cheap".
- Never claim anything the listing data does not support (do not invent part numbers,
  sizes, compatibility, or brand). If the current title is already strong, return it unchanged.
- If the input has "store_title_format", the title MUST follow it exactly: fill each {placeholder}
  in that order with facts from the listing, and copy all text outside the braces word-for-word
  (e.g. "Used OEM" stays exactly "Used OEM"). If a placeholder's value is unknown, leave it out
  rather than guessing. To stay within 80 characters, shorten the placeholders (abbreviate the
  location like "Front Left" -> "FL" only if needed, drop filler words) - never drop the fixed text.
  This store format overrides the general "search words first" ordering above.

Item specifics rules:
- Fill in MISSING aspects, prioritising REQUIRED then RECOMMENDED ones.
- Only use facts found in the title, description or existing specifics, or that follow with
  certainty from them. If unknown, leave the aspect out. Never guess. "Does Not Apply" only for
  Brand/MPN when the item is genuinely unbranded / has no part number.
- For SELECTION_ONLY aspects you must use one of the allowed values exactly as written.
- Use the exact aspect name as given.

Pricing rules:
- Compare against competitors with the same condition and the closest match (total price =
  price + shipping). Ignore listings that are clearly a different product, a lot/bundle, or
  parts-only.
- Recommend a price that is competitive for the item's quality and seller strength; it does
  not need to be the cheapest. If too few true matches exist, recommend 0 (= keep current price).
- Explain briefly which competitor prices you based this on.

Compatibility / fitment (vehicle parts only):
- The input may contain "part_numbers" and "fitment_evidence": vehicles found in the compatibility
  tables of other eBay listings selling the same part number, with how many listings agree.
  Vehicles that enough listings agree on are added automatically - do NOT repeat them.
- Return ADDITIONAL vehicles only, one row per model year (year, make, model; leave trim and
  engine empty unless the part only fits that trim/engine):
  * source "listing_text": fitment explicitly stated in this listing's title, description or
    specifics (e.g. "fits 2015-2018 Honda Civic" -> 4 rows).
  * source "part_number_knowledge": vehicles you know this exact OEM part number was fitted to
    (including other models/years that share the part, and evidence vehicles supported by only one
    listing that you can confirm). Use confidence "high" only when you are certain for that exact
    part number and position (front/rear, left/right); otherwise "medium"/"low". Never assume
    fitment from a similar-looking part or from the vehicle name alone.
- Every row is verified against eBay's vehicle catalog afterwards; use standard make/model names.
- If nothing applies, return an empty list.

Shipping: you cannot change shipping directly; give short advice in shipping_notes if the
handling time or shipping cost looks uncompetitive versus competitors, else an empty string.

Return JSON only, matching the schema.`;

export const SUGGESTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    title_reason: { type: "string" },
    item_specifics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          values: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
        required: ["name", "values", "source"],
        additionalProperties: false,
      },
    },
    recommended_price: { type: "number" },
    price_reason: { type: "string" },
    compatibility: {
      type: "array",
      items: {
        type: "object",
        properties: {
          year: { type: "string" },
          make: { type: "string" },
          model: { type: "string" },
          trim: { type: "string" },
          engine: { type: "string" },
          source: { type: "string", enum: ["listing_text", "part_number_knowledge"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["year", "make", "model", "trim", "engine", "source", "confidence"],
        additionalProperties: false,
      },
    },
    shipping_notes: { type: "string" },
    other_notes: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "title", "title_reason", "item_specifics", "recommended_price", "price_reason",
    "compatibility", "shipping_notes", "other_notes", "confidence",
  ],
  additionalProperties: false,
} as const;

export function missingAspectsForPrompt(aspects: Aspect[], existing: Record<string, string[]>) {
  const have = new Set(Object.keys(existing).map((k) => k.toLowerCase()));
  return aspects
    .filter((a) => !have.has(a.name.toLowerCase()) && (a.required || a.usage === "RECOMMENDED"))
    .map((a) => ({
      name: a.name,
      required: a.required,
      mode: a.mode,
      multi_value: a.multi,
      allowed_values: a.values.slice(0, a.mode === "SELECTION_ONLY" ? 60 : 15),
    }));
}

export interface ClaudeOptions {
  model: string;
  effort: "low" | "medium" | "high";
  inputPricePerMtok: number;
  outputPricePerMtok: number;
  /** store title format, e.g. "{Year range} {Brand} {Model} {Part name and location} {Part number} Used OEM" */
  titleTemplate?: string;
}

export interface SuggestResult {
  suggestion: ClaudeSuggestion;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

export async function suggestImprovements(
  item: EbayItem,
  aspects: Aspect[],
  competitors: Competitor[],
  opts: ClaudeOptions,
  fitment?: { partNumbers: string[]; summary: FitmentEvidence["summary"]; referenceCount: number },
): Promise<SuggestResult> {
  const { itemId, url, imageUrl, categoryId, conditionId, variationNames, compatibilityAll, site, ...listing } = item;
  const payload = {
    ...(opts.titleTemplate?.trim() ? { store_title_format: opts.titleTemplate.trim() } : {}),
    listing,
    missing_aspects: missingAspectsForPrompt(aspects, item.itemSpecifics),
    competitors: competitors.map(({ url: _u, ...c }) => c),
    ...(fitment?.partNumbers.length ? { part_numbers: fitment.partNumbers } : {}),
    ...(fitment?.summary.length
      ? { fitment_evidence: { reference_listings: fitment.referenceCount, vehicles: fitment.summary } }
      : {}),
  };
  const request = {
    model: opts.model,
    max_tokens: 16000,
    output_config: { effort: opts.effort, format: { type: "json_schema", schema: SUGGESTION_SCHEMA } },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  };

  const resp: any = FALLBACK_MODELS.has(opts.model)
    ? await getClient().beta.messages.create({
        ...(request as any),
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
    : await getClient().messages.create(request as any);

  const u = resp.usage ?? {};
  const inputTokens =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  const outputTokens = u.output_tokens ?? 0;
  const costUsd = (inputTokens / 1e6) * opts.inputPricePerMtok + (outputTokens / 1e6) * opts.outputPricePerMtok;

  if (resp.stop_reason === "refusal") throw Object.assign(new Error("Claude declined this listing"), { costUsd });
  if (resp.stop_reason === "max_tokens") throw Object.assign(new Error("Claude response was cut off"), { costUsd });
  const text = (resp.content ?? []).find((b: any) => b.type === "text")?.text ?? "";
  return { suggestion: JSON.parse(text) as ClaudeSuggestion, costUsd, inputTokens: Math.round(inputTokens), outputTokens };
}
