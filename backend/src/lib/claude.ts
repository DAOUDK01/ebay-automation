/** Asks Claude for listing improvements as structured JSON.
 *  Claude only SUGGESTS - guardrails.ts decides what is actually allowed to change. */
import Anthropic from "@anthropic-ai/sdk";
import type { Aspect, Competitor, EbayItem } from "./ebay/types";
import type { FitmentEvidence } from "./fitment";
import { descriptionToText } from "./description";
import type { ShippingEstimate } from "./shipping";

/** Models that accept server-side refusal fallbacks ("default" routing). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export interface ClaudeSuggestion {
  title: string;
  title_reason: string;
  item_specifics: {
    name: string;
    values: string[];
    source: "listing_text" | "other_listings" | "part_number_knowledge";
    confidence: "low" | "medium" | "high";
  }[];
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
  shipping_estimate: ShippingEstimate;
  shipping_notes: string;
  /** name of the store's part shipping policy this item belongs to, or "" (weight bracket) */
  shipping_part_policy?: string;
  description_content: DescriptionContent;
  other_notes: string;
  confidence: "low" | "medium" | "high";
}

/** Text blocks for the branded A+ description (the HTML layout comes from the store's template). */
export interface DescriptionContent {
  headline: string;
  intro: string;
  highlights: string[];
  fitment_summary: string;
  condition_notes: string;
  included: string[];
  install_tips: string;
  faqs: { q: string; a: string }[];
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
- Use plain, everyday words a buyer would type into eBay search: "Headlight" not "Headlamp
  Illumination Assembly", "Door Mirror" not "Exterior Rear View Mirror Unit", "Left"/"Right"
  rather than "Driver Side Lateral". No fancy, technical-sounding or marketing words.
- Year range: NEVER make the year range in the current title smaller (never raise the start year or
  lower the end year). You may widen it only when the fitment/compatibility evidence clearly
  supports the extra years; otherwise keep the current years exactly.
- Never claim anything the listing data does not support (do not invent part numbers,
  sizes, compatibility, or brand). If the current title is already strong, return it unchanged.
- If the input has "store_title_format", the title MUST follow it exactly: fill each {placeholder}
  in that order with facts from the listing, and copy all text outside the braces word-for-word
  (e.g. "OEM Used" stays exactly "OEM Used"). If a placeholder's value is unknown, leave it out
  rather than guessing. To stay within 80 characters, shorten the placeholders (abbreviate the
  location like "Front Left" -> "FL" only if needed, drop filler words) - never drop the fixed text.
  This store format overrides the general "search words first" ordering above.

Item specifics rules (more complete specifics = better search ranking, so fill as many as you can
determine reliably):
- "missing_aspects" lists every aspect eBay supports for the category that the listing doesn't have
  yet (REQUIRED first, then RECOMMENDED, then OPTIONAL). Go through them ONE BY ONE and fill every
  aspect you can determine from the title, description, photos' captions, existing specifics,
  specifics_evidence or your knowledge of this exact part number. A well-listed auto part usually
  has 25-40 specifics - do not stop after the obvious ones.
- Auto-part aspects to always work through when the category has them: Brand, Manufacturer Part
  Number, OE/OEM Part Number, Interchange Part Number, Superseded Part Number, Placement on Vehicle
  (all that apply, e.g. Front + Left), Type, Fitment Type, Material, Finish / Surface Finish, Color
  (only if the listing says it), Features, Bulb Type / Lens Color / Connector / Number of Pins for
  electrical parts, Number of Pieces, Items Included (listing only), Mounting Hardware Included,
  Vehicle Make / Model / Year aspects, Country/Region of Manufacture (only if known), Performance
  Part (No for OEM), Manufacturer Warranty (listing only).
- You may also add other clearly useful buyer-facing specifics that are not in missing_aspects (e.g.
  "Connector Type", "Number of Pins", "Mounting Style"), at most 10, short names, factual values.
- "specifics_evidence" (if present) shows the item specifics used by other eBay listings of the SAME
  part number, with how many listings use each value. Use it for part-level facts.
- You may also add these part-number specifics even if not in missing_aspects: "Interchange Part
  Number", "Superseded Part Number", "OE/OEM Part Number", "Manufacturer Part Number", "Other Part
  Number" (multiple values allowed, one part number per value).
- Every value needs a source:
  * "listing_text": stated in this listing's title, description or existing specifics.
  * "other_listings": taken from specifics_evidence (prefer values several listings agree on).
  * "part_number_knowledge": you know it for certain about this exact OEM part number (e.g.
    interchange/superseded numbers, mirror features like heated/power-folding, material, type).
  Set confidence honestly: "high" = certain, "medium" = very likely for this exact part number
  (used), "low" = a guess (not used).
- Attributes that can differ between two copies of the same part - Color, Condition, Warranty,
  Items Included, Custom Bundle, Modified Item - must come ONLY from this listing's own text.
- Weight and size specifics (Item Weight, any "... Weight", Dimensions, Item Length/Width/Height) only
  from this listing's own text - never from other listings or your knowledge.
- Never contradict this listing (position, side, condition). Leave an aspect out if unsure.
  "Does Not Apply" only for Brand/MPN when the item is genuinely unbranded / has no part number.
- For SELECTION_ONLY aspects use one of the allowed values exactly as written; use the exact aspect
  name as given; each value max 65 characters.

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

Shipping:
- shipping_estimate: estimate the PACKED shipment for this exact part as it would ship (part plus
  box/padding): weight_kg and the box length_cm, width_cm, height_cm. Base it on what the part
  physically is (identify it from the part number and title); do not trust weights quoted by other
  sellers, they are often wrong. Use the part type, size and
  material (e.g. a car door shell or bumper ships in a large box; a sensor in a small one), and any
  weight/size stated in the listing. If the listing's package details are given, they win - copy
  them. basis = one short sentence on how you estimated; confidence honest. If you truly can't
  tell, return zeros with confidence "low".
- shipping_part_policy: "part_shipping_policies" (if present) are the store's shipping policies for
  specific kinds of part. Return the exact policy name ONLY if this item IS that whole part (e.g. a
  complete transmission/gearbox for a "Gear Box" policy, a complete engine for an "Engine" policy).
  Return "" for accessories or pieces of it (transmission mount, control module, engine wiring harness,
  headlight leveling motor) and for anything else - e.g. a "Liftgate Motor and Gear" is NOT a gear box.
  Return "" when part_shipping_policies is absent.
- shipping_notes: short advice if handling time or shipping cost looks uncompetitive versus
  competitors, else an empty string.

Description (description_content) - the text for a branded "A+" product description. The store's
template does the layout, branding, photos, specs table, compatibility table and policies; you write
the words only (plain text, no HTML, no links, no emails/phone numbers, no emojis):
- Plain, friendly, easy English a normal buyer understands. Short sentences. Facts only - never invent
  features, condition details, part numbers or fitment that the listing data/evidence does not support.
- headline: one short line naming the part, e.g. "Genuine Honda Civic Front Left Headlight".
- intro: 2-3 sentences: what the part is, which vehicles it fits (broadly), and that it is a used
  genuine OEM part pulled from a vehicle (only if the listing says used/OEM).
- highlights: 4-6 short bullet points of real buyer benefits/facts (OEM quality, exact part number,
  position, what it connects to, tested/inspected only if stated in the listing).
- fitment_summary: one or two sentences summarising compatible vehicles and reminding the buyer to
  check the part number / compatibility table before buying.
- condition_notes: honest condition from the listing's condition and condition description / current
  description (wear, scratches, missing tabs). If nothing is stated, say it is a used part with
  normal signs of use and to check the photos. Never claim "new" or "perfect".
- included: what's in the box, only what the listing supports (e.g. "Headlight assembly only - bulbs
  not included" if stated); [] if unknown.
- install_tips: one short practical tip, or "" if nothing useful.
- faqs: 3-4 short questions buyers of THIS part really ask (fit, condition, what is included, part
  number / interchange, wiring or connectors) with short honest answers based only on the data;
  say "Message us with your VIN" when fitment depends on options.
- Store return policy (always, for every listing): 30-day returns accepted, the buyer pays return
  shipping. If any text mentions returns, use exactly this - never free returns, never another
  number of days, never "no returns".
- "current_description_text" (if present) is the listing's current description as plain text: keep its
  important facts (condition, what's included, notes) in your content.

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
          source: { type: "string", enum: ["listing_text", "other_listings", "part_number_knowledge"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["name", "values", "source", "confidence"],
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
    shipping_estimate: {
      type: "object",
      properties: {
        weight_kg: { type: "number" },
        length_cm: { type: "number" },
        width_cm: { type: "number" },
        height_cm: { type: "number" },
        basis: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["weight_kg", "length_cm", "width_cm", "height_cm", "basis", "confidence"],
      additionalProperties: false,
    },
    shipping_notes: { type: "string" },
    shipping_part_policy: { type: "string" },
    description_content: {
      type: "object",
      properties: {
        headline: { type: "string" },
        intro: { type: "string" },
        highlights: { type: "array", items: { type: "string" } },
        fitment_summary: { type: "string" },
        condition_notes: { type: "string" },
        included: { type: "array", items: { type: "string" } },
        install_tips: { type: "string" },
        faqs: {
          type: "array",
          items: {
            type: "object",
            properties: { q: { type: "string" }, a: { type: "string" } },
            required: ["q", "a"],
            additionalProperties: false,
          },
        },
      },
      required: ["headline", "intro", "highlights", "fitment_summary", "condition_notes", "included", "install_tips", "faqs"],
      additionalProperties: false,
    },
    other_notes: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "title", "title_reason", "item_specifics", "recommended_price", "price_reason",
    "compatibility", "shipping_estimate", "shipping_notes", "shipping_part_policy", "description_content", "other_notes", "confidence",
  ],
  additionalProperties: false,
} as const;

/** Every aspect of the category the listing doesn't have yet: required, then recommended, then optional. */
export function missingAspectsForPrompt(aspects: Aspect[], existing: Record<string, string[]>) {
  const have = new Set(Object.keys(existing).map((k) => k.toLowerCase()));
  const rank = (a: Aspect) => (a.required ? 0 : a.usage === "RECOMMENDED" ? 1 : 2);
  return aspects
    .filter((a) => !have.has(a.name.toLowerCase()))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 100)
    .map((a) => ({
      name: a.name,
      importance: a.required ? "REQUIRED" : a.usage === "RECOMMENDED" ? "RECOMMENDED" : "OPTIONAL",
      mode: a.mode,
      multi_value: a.multi,
      allowed_values: a.values.slice(0, a.mode === "SELECTION_ONLY" ? 200 : 15),
    }));
}

export interface ClaudeOptions {
  model: string;
  effort: "low" | "medium" | "high";
  inputPricePerMtok: number;
  outputPricePerMtok: number;
  /** store title format, e.g. "{Year range} {Brand} {Model} {Part name and location} {Part number} OEM Used" */
  titleTemplate?: string;
  /** include the current description text so the A+ content keeps its facts */
  wantDescription?: boolean;
  /** the store's shipping policies named after a part type, e.g. { name: "Gear Box Shipping Policy", part: "transmission" } */
  partPolicies?: { name: string; part: string }[];
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
  fitment?: {
    partNumbers: string[];
    summary: FitmentEvidence["summary"];
    referenceCount: number;
    specifics?: FitmentEvidence["specifics"];
  },
): Promise<SuggestResult> {
  const { itemId, url, imageUrl, categoryId, conditionId, variationNames, compatibilityAll, site, pictures, descriptionHtml, ...listing } =
    item;
  const payload = {
    ...(opts.titleTemplate?.trim() ? { store_title_format: opts.titleTemplate.trim() } : {}),
    listing,
    ...(opts.wantDescription && descriptionHtml ? { current_description_text: descriptionToText(descriptionHtml).slice(0, 4000) } : {}),
    ...(opts.partPolicies?.length ? { part_shipping_policies: opts.partPolicies } : {}),
    missing_aspects: missingAspectsForPrompt(aspects, item.itemSpecifics),
    competitors: competitors.map(({ url: _u, ...c }) => c),
    ...(fitment?.partNumbers.length ? { part_numbers: fitment.partNumbers } : {}),
    ...(fitment?.summary.length
      ? { fitment_evidence: { reference_listings: fitment.referenceCount, vehicles: fitment.summary } }
      : {}),
    ...(fitment?.specifics?.length ? { specifics_evidence: fitment.specifics } : {}),
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
