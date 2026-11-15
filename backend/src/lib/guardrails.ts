/** Hard rules in code (not in Claude) that decide which suggested edits are allowed. Pure functions. */
import type { StoreSettings } from "../models/Store";
import type { ClaudeSuggestion } from "./claude";
import type { Aspect, CompatRow, EbayItem, FitmentRow, Specifics } from "./ebay/types";
import { PER_COPY_SPECIFICS, toCompatRows } from "./fitment";

const BANNED_TITLE = /(l@@k|\bwow\b|!!|\*|\bbest\b|\bcheap\b|free shipping)/i;

export interface CheckResult<T> {
  value: T | null;
  note: string;
}

/** Fixed text in a title template = everything outside {…}, e.g. "OEM Used". */
export function templateLiterals(template: string | undefined): string[] {
  if (!template?.trim()) return [];
  return template
    .split(/\{[^}]*\}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const YEAR = "(19[5-9]\\d|20\\d{2})";
const RANGE_RE = new RegExp(`(?<![\\w-])${YEAR}\\s*[-–]\\s*(${YEAR.slice(1, -1)}|\\d{2})(?![\\w-])`);
const SINGLE_RE = new RegExp(`(?<![\\w-])${YEAR}(?![\\w-])`);

/** First year range ("2016-2021", "2016-21") or single year in a title. */
export function titleYears(title: string): { start: number; end: number; text: string; index: number } | null {
  const r = RANGE_RE.exec(title);
  if (r) {
    const start = Number(r[1]);
    let end = Number(r[2]);
    if (r[2].length === 2) end = Math.floor(start / 100) * 100 + end + (end < start % 100 ? 100 : 0);
    if (end >= start) return { start, end, text: r[0], index: r.index };
  }
  const s = SINGLE_RE.exec(title);
  return s ? { start: Number(s[1]), end: Number(s[1]), text: s[0], index: s.index } : null;
}

/**
 * The year range in a title may only grow: if the new title narrows or drops the current range,
 * put back the union of both (start = earliest, end = latest).
 */
export function keepYearRange(oldTitle: string, newTitle: string): { title: string; note?: string } {
  const before = titleYears(oldTitle);
  if (!before) return { title: newTitle };
  const after = titleYears(newTitle);
  const fmt = (a: number, b: number) => (a === b ? String(a) : `${a}-${b}`);
  if (!after) return { title: `${before.text} ${newTitle}`, note: `kept year range ${before.text}` };
  if (after.start <= before.start && after.end >= before.end) return { title: newTitle };
  const range = fmt(Math.min(after.start, before.start), Math.max(after.end, before.end));
  return {
    title: newTitle.slice(0, after.index) + range + newTitle.slice(after.index + after.text.length),
    note: `year range ${after.text} would shrink ${before.text} - kept ${range}`,
  };
}

export function checkTitle(oldTitle: string, newTitle: string, template?: string): CheckResult<string> {
  let t = (newTitle || "").replace(/\s+/g, " ").trim();
  if (!t) return { value: null, note: "title unchanged" };
  const years = keepYearRange(oldTitle, t);
  t = years.title;
  if (t === oldTitle.trim()) return { value: null, note: "title unchanged" };
  if (years.note && t.length > 80) return { value: null, note: `title rejected: ${years.note}, then ${t.length} chars > 80` };
  if (t.length > 80) return { value: null, note: `title rejected: ${t.length} chars > 80` };
  if (BANNED_TITLE.test(t)) return { value: null, note: "title rejected: banned words/symbols" };
  const missing = templateLiterals(template).filter((lit) => !t.toLowerCase().includes(lit.toLowerCase()));
  if (missing.length) return { value: null, note: `title rejected: missing required text ${missing.map((m) => `"${m}"`).join(", ")}` };
  if (t.length < Math.min(oldTitle.length, 80) * 0.7) return { value: null, note: "title rejected: much shorter than current" };
  return { value: t, note: years.note ? `title: ok (${years.note})` : "title: ok" };
}

export function priceFloor(cost: number, p: StoreSettings["modules"]["pricing"]): number {
  return Math.round(((cost * (1 + p.minMarginPct / 100)) / (1 - p.feePct / 100)) * 100) / 100;
}

export function checkPrice(
  item: Pick<EbayItem, "price" | "hasVariations">,
  suggested: number,
  cost: number | null,
  p: StoreSettings["modules"]["pricing"],
): CheckResult<number> {
  const old = item.price;
  if (!p.enabled) return { value: null, note: "price: module disabled" };
  if (item.hasVariations) return { value: null, note: "price: variation listing - not handled" };
  if (!suggested || suggested <= 0 || old <= 0) return { value: null, note: "price: keep current" };
  const max = p.maxChangePct / 100;
  let next = Math.min(Math.max(suggested, old * (1 - max)), old * (1 + max));
  next = Math.round(next * 100) / 100;
  if (Math.abs(next - old) / old < 0.01) return { value: null, note: "price: change < 1%, skipped" };
  if (next < old) {
    if (cost === null || cost === undefined) {
      if (p.requireCostForDecrease) return { value: null, note: `price: decrease to ${next} needs your cost` };
    } else {
      const floor = priceFloor(cost, p);
      if (next < floor) {
        if (old <= floor) return { value: null, note: `price: already at/below floor ${floor}` };
        next = floor;
      }
    }
  }
  if (p.minPrice && next < p.minPrice) return { value: null, note: `price: below min price ${p.minPrice}` };
  return { value: next, note: `price: ${old} -> ${next} (Claude suggested ${suggested})` };
}

/** Returns the FULL new specifics set (eBay replaces the whole set on revise) or null if nothing changes. */
/** Part-number specifics eBay accepts as custom names even when not in the category's aspect list. */
const PART_NUMBER_SPECIFICS = new Map(
  ["Interchange Part Number", "Superseded Part Number", "OE/OEM Part Number", "Manufacturer Part Number", "Other Part Number"].map((n) => [
    n.toLowerCase(),
    n,
  ]),
);
const MAX_SPECIFICS = 45;
/** custom (non-category) names allowed beyond part numbers, so category aspects keep priority */
const MAX_CUSTOM = 12;
const CUSTOM_NAME_OK = /^[A-Za-z][A-Za-z0-9 /&()'.,-]{1,64}$/;

/**
 * Safe values for a used-OEM parts store, filled only when the category has the aspect, the listing
 * doesn't set it yet and the value is allowed. A genuine OEM part is a direct replacement and is sold
 * as-is (not modified, not a bundle).
 */
const STORE_DEFAULTS: { name: string; value: string; when: (title: string) => boolean }[] = [
  { name: "Fitment Type", value: "Direct Replacement", when: (t) => /\boem\b|\bgenuine\b/i.test(t) },
  { name: "Modified Item", value: "No", when: () => true },
  { name: "Custom Bundle", value: "No", when: () => true },
];

export function checkSpecifics(
  item: Pick<EbayItem, "itemSpecifics" | "variationNames"> & { title?: string },
  suggested: ClaudeSuggestion["item_specifics"],
  aspects: Aspect[],
  s: StoreSettings["modules"]["specifics"],
  /** specific names used by other listings of the same part number (allowed as custom names) */
  evidenceNames: string[] = [],
): { value: Specifics | null; notes: string[] } {
  if (!s.enabled) return { value: null, notes: ["specifics: module disabled"] };
  const byName = new Map(aspects.map((a) => [a.name.toLowerCase(), a]));
  const evidence = new Map(evidenceNames.map((n) => [n.toLowerCase(), n]));
  const variation = new Set(item.variationNames.map((n) => n.toLowerCase()));
  const current: Specifics = Object.fromEntries(Object.entries(item.itemSpecifics).map(([k, v]) => [k, [...v]]));
  const currentLower = new Map(Object.keys(current).map((k) => [k.toLowerCase(), k]));
  const notes: string[] = [];
  let changed = false;
  let customCount = 0;
  const title = item.title ?? "";

  // category aspects first (required > recommended > optional), custom names last - so the 45 limit keeps the important ones
  const rank = (n: string) => {
    const a = byName.get(n.toLowerCase());
    return !a ? 3 : a.required ? 0 : a.usage === "RECOMMENDED" ? 1 : 2;
  };
  const ordered = [...(suggested ?? [])].sort((x, y) => rank(x.name ?? "") - rank(y.name ?? ""));

  for (const sug of ordered) {
    let name = (sug.name || "").trim();
    let values = [...new Set((sug.values ?? []).map((v) => v.trim()).filter(Boolean))];
    if (!name || !values.length) continue;
    const source = sug.source ?? "listing_text";
    // part-level facts Claude knows from the part number: high and medium are used, low is not
    if (source === "part_number_knowledge" && (!s.allowKnowledge || sug.confidence === "low")) {
      notes.push(`skip '${name}': part-number knowledge ${s.allowKnowledge ? `(${sug.confidence} confidence)` : "(disabled)"}`);
      continue;
    }
    if (source === "other_listings" && !s.useOtherListings) continue;
    if (source !== "listing_text" && PER_COPY_SPECIFICS.test(name)) {
      notes.push(`skip '${name}': describes this copy of the part, so it must come from your own listing`);
      continue;
    }
    const a = byName.get(name.toLowerCase());
    if (!a) {
      const known = PART_NUMBER_SPECIFICS.get(name.toLowerCase()) ?? evidence.get(name.toLowerCase());
      // any other useful buyer-facing name (e.g. "Connector Type") as a custom specific, capped
      const free = !known && CUSTOM_NAME_OK.test(name) && customCount < MAX_CUSTOM;
      if (!s.allowCustomNames || (!known && !free)) {
        notes.push(`skip '${name}': ${!s.allowCustomNames ? "custom names disabled" : customCount >= MAX_CUSTOM ? `custom specifics limit (${MAX_CUSTOM})` : "not a valid name"}`);
        continue;
      }
      if (free) customCount++;
      name = known ?? name;
      values = values.filter((v) => v.length <= 65).slice(0, 30);
      if (!values.length) continue;
    } else {
      name = a.name;
    }
    if (variation.has(name.toLowerCase())) continue;
    if (a && a.mode === "SELECTION_ONLY") {
      const allowed = new Map(a.values.map((v) => [v.toLowerCase(), v]));
      const bad = values.filter((v) => !allowed.has(v.toLowerCase()));
      // keep the allowed values; drop only the wrong ones
      values = values.filter((v) => allowed.has(v.toLowerCase())).map((v) => allowed.get(v.toLowerCase())!);
      if (!values.length) {
        notes.push(`skip '${name}': value(s) ${JSON.stringify(bad)} not in eBay's list`);
        continue;
      }
      if (bad.length) notes.push(`'${name}': dropped value(s) ${JSON.stringify(bad)} not in eBay's list`);
    }
    if (a && !a.multi) values = values.slice(0, 1);
    if (a?.maxLength) values = values.filter((v) => v.length <= a.maxLength!);
    if (!values.length) continue;

    const existingKey = currentLower.get(name.toLowerCase());
    const via = source === "listing_text" ? "" : source === "other_listings" ? " (from other listings)" : " (part-number knowledge)";
    if (existingKey) {
      if (!s.overwriteExisting || JSON.stringify(current[existingKey]) === JSON.stringify(values)) continue;
      notes.push(`overwrite '${name}': ${JSON.stringify(current[existingKey])} -> ${JSON.stringify(values)}${via}`);
      current[existingKey] = values;
    } else {
      if (Object.keys(current).length >= MAX_SPECIFICS) {
        notes.push(`skip '${name}': eBay allows max ${MAX_SPECIFICS} item specifics`);
        continue;
      }
      notes.push(`add '${name}': ${JSON.stringify(values)}${via}`);
      current[name] = values;
      currentLower.set(name.toLowerCase(), name);
    }
    changed = true;
  }

  // store defaults for aspects nobody filled
  for (const d of STORE_DEFAULTS) {
    const a = byName.get(d.name.toLowerCase());
    if (!a || currentLower.has(d.name.toLowerCase()) || !d.when(title)) continue;
    if (variation.has(a.name.toLowerCase()) || Object.keys(current).length >= MAX_SPECIFICS) continue;
    if (a.mode === "SELECTION_ONLY" && !a.values.some((v) => v.toLowerCase() === d.value.toLowerCase())) continue;
    const value = a.values.find((v) => v.toLowerCase() === d.value.toLowerCase()) ?? d.value;
    current[a.name] = [value];
    currentLower.set(a.name.toLowerCase(), a.name);
    notes.push(`add '${a.name}': ["${value}"] (store default)`);
    changed = true;
  }
  return { value: changed ? current : null, notes };
}

/** Researched fitment rows (see lib/fitment.ts) -> what gets pushed. Report-only unless `apply` is on. */
export function checkCompatibility(
  rows: FitmentRow[],
  c: StoreSettings["modules"]["compatibility"],
): CheckResult<CompatRow[]> & { suggested: FitmentRow[] } {
  if (!c.enabled || !rows.length) return { value: null, note: "", suggested: [] };
  const bySource = (s: string) => rows.filter((r) => r._source === s).length;
  const detail = [
    bySource("ebay_listings") && `${bySource("ebay_listings")} from other eBay listings`,
    bySource("listing_text") && `${bySource("listing_text")} from the listing text`,
    bySource("part_number_knowledge") && `${bySource("part_number_knowledge")} from part-number knowledge`,
  ]
    .filter(Boolean)
    .join(", ");
  if (!c.apply) {
    return { value: null, note: `compatibility: ${rows.length} vehicles found (${detail}) - report only`, suggested: rows };
  }
  return { value: toCompatRows(rows), note: `compatibility: add ${rows.length} vehicles (${detail})`, suggested: rows };
}

/** Is local time (in tz) inside "HH:MM-HH:MM"? Handles windows that cross midnight. */
export function inActiveHours(ah: StoreSettings["activeHours"], now = new Date()): boolean {
  if (!ah.enabled) return true;
  const t = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ah.timezone })
    .format(now)
    .replace(/^24/, "00");
  return ah.start < ah.end ? t >= ah.start && t < ah.end : t >= ah.start || t < ah.end;
}
