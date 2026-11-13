/** Hard rules in code (not in Claude) that decide which suggested edits are allowed. Pure functions. */
import type { StoreSettings } from "../models/Store";
import type { ClaudeSuggestion } from "./claude";
import type { Aspect, CompatRow, EbayItem, Specifics } from "./ebay/types";

const BANNED_TITLE = /(l@@k|\bwow\b|!!|\*|\bbest\b|\bcheap\b|free shipping)/i;

export interface CheckResult<T> {
  value: T | null;
  note: string;
}

export function checkTitle(oldTitle: string, newTitle: string): CheckResult<string> {
  const t = (newTitle || "").replace(/\s+/g, " ").trim();
  if (!t || t === oldTitle.trim()) return { value: null, note: "title unchanged" };
  if (t.length > 80) return { value: null, note: `title rejected: ${t.length} chars > 80` };
  if (BANNED_TITLE.test(t)) return { value: null, note: "title rejected: banned words/symbols" };
  if (t.length < Math.min(oldTitle.length, 80) * 0.7) return { value: null, note: "title rejected: much shorter than current" };
  return { value: t, note: "title: ok" };
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
export function checkSpecifics(
  item: Pick<EbayItem, "itemSpecifics" | "variationNames">,
  suggested: ClaudeSuggestion["item_specifics"],
  aspects: Aspect[],
  s: StoreSettings["modules"]["specifics"],
): { value: Specifics | null; notes: string[] } {
  if (!s.enabled) return { value: null, notes: ["specifics: module disabled"] };
  const byName = new Map(aspects.map((a) => [a.name.toLowerCase(), a]));
  const variation = new Set(item.variationNames.map((n) => n.toLowerCase()));
  const current: Specifics = Object.fromEntries(Object.entries(item.itemSpecifics).map(([k, v]) => [k, [...v]]));
  const currentLower = new Map(Object.keys(current).map((k) => [k.toLowerCase(), k]));
  const notes: string[] = [];
  let changed = false;

  for (const sug of suggested ?? []) {
    let name = (sug.name || "").trim();
    let values = (sug.values ?? []).map((v) => v.trim()).filter(Boolean);
    if (!name || !values.length) continue;
    const a = byName.get(name.toLowerCase());
    if (!a) {
      notes.push(`skip '${name}': not an aspect of this category`);
      continue;
    }
    name = a.name;
    if (variation.has(name.toLowerCase())) continue;
    if (a.mode === "SELECTION_ONLY") {
      const allowed = new Map(a.values.map((v) => [v.toLowerCase(), v]));
      const bad = values.filter((v) => !allowed.has(v.toLowerCase()));
      if (bad.length) {
        notes.push(`skip '${name}': value(s) ${JSON.stringify(bad)} not allowed`);
        continue;
      }
      values = values.map((v) => allowed.get(v.toLowerCase())!);
    }
    if (!a.multi) values = values.slice(0, 1);
    if (a.maxLength) values = values.filter((v) => v.length <= a.maxLength!);
    if (!values.length) continue;

    const existingKey = currentLower.get(name.toLowerCase());
    if (existingKey) {
      if (!s.overwriteExisting || JSON.stringify(current[existingKey]) === JSON.stringify(values)) continue;
      notes.push(`overwrite '${name}': ${JSON.stringify(current[existingKey])} -> ${JSON.stringify(values)}`);
      current[existingKey] = values;
    } else {
      notes.push(`add '${name}': ${JSON.stringify(values)}`);
      current[name] = values;
      currentLower.set(name.toLowerCase(), name);
    }
    changed = true;
  }
  if (Object.keys(current).length > 45) return { value: null, notes: [...notes, "specifics: too many (>45), skipped"] };
  return { value: changed ? current : null, notes };
}

export function checkCompatibility(
  item: Pick<EbayItem, "compatibilitySample">,
  rows: ClaudeSuggestion["compatibility"],
  c: StoreSettings["modules"]["compatibility"],
): CheckResult<CompatRow[]> & { suggested: CompatRow[] } {
  if (!c.enabled) return { value: null, note: "", suggested: [] };
  const existing = new Set(item.compatibilitySample.map((r) => `${r.Year}|${r.Make}|${r.Model}`));
  const clean: CompatRow[] = [];
  for (const r of rows ?? []) {
    const year = r.year?.trim();
    if (!year || !/^(19|20)\d\d$/.test(year) || !r.make?.trim() || !r.model?.trim()) continue;
    const row: CompatRow = { Year: year, Make: r.make.trim(), Model: r.model.trim() };
    if (r.trim?.trim()) row.Trim = r.trim.trim();
    if (r.engine?.trim()) row.Engine = r.engine.trim();
    if (!existing.has(`${row.Year}|${row.Make}|${row.Model}`)) clean.push(row);
  }
  if (!clean.length) return { value: null, note: "", suggested: [] };
  const limited = clean.slice(0, 100);
  if (!c.apply) {
    return { value: null, note: `compatibility: ${limited.length} rows suggested (report only)`, suggested: limited };
  }
  return { value: limited, note: `compatibility: add ${limited.length} rows`, suggested: limited };
}

/** Is local time (in tz) inside "HH:MM-HH:MM"? Handles windows that cross midnight. */
export function inActiveHours(ah: StoreSettings["activeHours"], now = new Date()): boolean {
  if (!ah.enabled) return true;
  const t = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ah.timezone })
    .format(now)
    .replace(/^24/, "00");
  return ah.start < ah.end ? t >= ah.start && t < ah.end : t >= ah.start || t < ah.end;
}
