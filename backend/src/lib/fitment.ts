/**
 * Fitment (parts compatibility) research.
 *
 * Sources, in order of trust:
 *  1. ebay_listings          - other eBay listings with the same part number; their compatibility tables use
 *                              eBay's exact catalog values (Year/Make/Model/Trim/Engine). A vehicle is used when at
 *                              least `minListings` of those listings agree.
 *  2. listing_text           - fitment stated in this listing's own title/description/specifics (via Claude).
 *  3. part_number_knowledge  - Claude's knowledge of the OEM part number (high confidence only, if enabled).
 * Rows from 2 and 3 are verified against eBay's vehicle catalog (Taxonomy API) and rewritten in eBay's spelling;
 * rows eBay doesn't recognise are dropped.
 */
import type { StoreSettings } from "../models/Store";
import type { ClaudeSuggestion } from "./claude";
import type { CompatRow, EbayItem, FitmentReference, FitmentRow } from "./ebay/types";

export const MAX_FITMENT_ROWS = 1000;
const FIELDS = ["Year", "Make", "Model", "Trim", "Engine"] as const;

const PN_SPECIFICS = [
  "Manufacturer Part Number",
  "MPN",
  "OE/OEM Part Number",
  "OEM Part Number",
  "Interchange Part Number",
  "Other Part Number",
];

const normPn = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Part numbers from item specifics + part-number-looking tokens in the title (max 3). */
export function extractPartNumbers(item: Pick<EbayItem, "title" | "itemSpecifics">): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const v = raw.trim();
    if (!v || /^(does not apply|n\/?a|none|unknown)$/i.test(v)) return;
    if (/^(19|20)\d\d\s*-\s*(19|20)?\d\d$/.test(v)) return; // year range
    const n = normPn(v);
    if (n.length < 5 || !/\d/.test(n)) return;
    if (!found.some((f) => normPn(f) === n)) found.push(v);
  };
  for (const key of PN_SPECIFICS) {
    for (const v of item.itemSpecifics?.[key] ?? []) v.split(/[,;/]\s*/).forEach(add);
  }
  // title tokens like 67002-0C060, 90919-02240, 8K0941029AA
  const tokens = item.title.match(/\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){1,3}\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{7,}\b/gi) ?? [];
  tokens.forEach(add);
  return found.slice(0, 3);
}

const ymmKey = (r: CompatRow) => `${r.Year}|${r.Make}|${r.Model}`.toLowerCase();
const fullKey = (r: CompatRow) => FIELDS.map((f) => r[f] ?? "").join("|").toLowerCase();
const pick = (r: CompatRow): CompatRow => {
  const o: CompatRow = {};
  for (const f of FIELDS) if (r[f]) o[f] = r[f];
  return o;
};

export interface FitmentEvidence {
  partNumbers: string[];
  references: FitmentReference[];
  /** every distinct vehicle row seen, with how many reference listings contain it */
  rows: { row: CompatRow; support: number }[];
  /** compact Year/Make/Model summary sent to Claude */
  summary: { year: string; make: string; model: string; listings: number; trims: number }[];
}

export const EMPTY_EVIDENCE: FitmentEvidence = { partNumbers: [], references: [], rows: [], summary: [] };

export interface FitmentDeps {
  searchByPartNumber?: (pn: string, opts: { excludeSeller?: string; limit?: number }) => Promise<{ itemId: string; title: string; url: string }[]>;
  getItemCompatibility?: (itemId: string) => Promise<{ itemId: string; title: string; rows: CompatRow[] }>;
  validateVehicle?: (
    categoryId: string,
    v: { Year: string; Make: string; Model: string },
  ) => Promise<{ Year: string; Make: string; Model: string } | null | undefined>;
}

/** Look up other eBay listings of the same part number and read their compatibility tables. */
export async function gatherFitmentEvidence(
  item: EbayItem,
  deps: FitmentDeps,
  s: StoreSettings,
  log: (msg: string) => void = () => {},
): Promise<FitmentEvidence> {
  const c = s.modules.compatibility;
  const partNumbers = extractPartNumbers(item);
  if (!c.enabled || !c.researchEbay || !partNumbers.length || !deps.searchByPartNumber || !deps.getItemCompatibility) {
    return { ...EMPTY_EVIDENCE, partNumbers };
  }
  const references: FitmentReference[] = [];
  const rowMap = new Map<string, { row: CompatRow; refs: Set<string> }>();
  const seen = new Set<string>([item.itemId]);
  for (const pn of partNumbers) {
    if (references.length >= c.maxReferenceListings) break;
    let hits: { itemId: string; title: string; url: string }[] = [];
    try {
      hits = await deps.searchByPartNumber(pn, { excludeSeller: s.excludeSeller, limit: c.maxReferenceListings * 2 });
    } catch (e: any) {
      log(`part number search failed for ${pn}: ${e?.message ?? e}`);
    }
    for (const h of hits) {
      if (references.length >= c.maxReferenceListings) break;
      if (seen.has(h.itemId)) continue;
      seen.add(h.itemId);
      try {
        const { rows } = await deps.getItemCompatibility(h.itemId);
        const clean = rows.map(pick).filter((r) => r.Year && r.Make && r.Model);
        if (!clean.length) continue; // listing without a fitment table - not useful
        references.push({ itemId: h.itemId, title: h.title, url: h.url, partNumber: pn, rowCount: clean.length });
        for (const r of clean) {
          const k = fullKey(r);
          if (!rowMap.has(k)) rowMap.set(k, { row: r, refs: new Set() });
          rowMap.get(k)!.refs.add(h.itemId);
        }
      } catch (e: any) {
        log(`could not read fitment of ${h.itemId}: ${e?.message ?? e}`);
      }
    }
  }
  const rows = [...rowMap.values()].map((v) => ({ row: v.row, support: v.refs.size }));
  const groups = new Map<string, { year: string; make: string; model: string; refs: Set<string>; trims: Set<string> }>();
  for (const v of rowMap.values()) {
    const k = ymmKey(v.row);
    if (!groups.has(k)) groups.set(k, { year: v.row.Year, make: v.row.Make, model: v.row.Model, refs: new Set(), trims: new Set() });
    const g = groups.get(k)!;
    v.refs.forEach((r) => g.refs.add(r));
    if (v.row.Trim || v.row.Engine) g.trims.add(`${v.row.Trim ?? ""}|${v.row.Engine ?? ""}`);
  }
  const summary = [...groups.values()]
    .map((g) => ({ year: g.year, make: g.make, model: g.model, listings: g.refs.size, trims: g.trims.size }))
    .sort((a, b) => b.listings - a.listings || a.make.localeCompare(b.make) || a.model.localeCompare(b.model) || a.year.localeCompare(b.year))
    .slice(0, 300);
  return { partNumbers, references, rows, summary };
}

/**
 * Final fitment rows for a listing:
 *  - every vehicle that >= minListings reference listings agree on (exact eBay rows incl. trim/engine)
 *  - plus Claude's listing_text / part_number_knowledge rows that pass eBay catalog validation
 * minus vehicles the listing already has.
 */
export async function buildFitmentRows(
  item: EbayItem,
  evidence: FitmentEvidence,
  claudeRows: ClaudeSuggestion["compatibility"],
  deps: FitmentDeps,
  s: StoreSettings,
): Promise<{ rows: FitmentRow[]; dropped: string[] }> {
  const c = s.modules.compatibility;
  const dropped: string[] = [];
  if (!c.enabled) return { rows: [], dropped };

  const existing = item.compatibilityAll ?? item.compatibilitySample ?? [];
  const existingFull = new Set(existing.map(fullKey));
  const existingYmm = new Set(existing.map(ymmKey));
  const out = new Map<string, FitmentRow>();
  const outYmm = new Set<string>();
  const add = (r: FitmentRow) => {
    const fk = fullKey(r);
    const yk = ymmKey(r);
    const ymmOnly = !r.Trim && !r.Engine;
    if (existingFull.has(fk) || out.has(fk)) return;
    if (ymmOnly && (existingYmm.has(yk) || outYmm.has(yk))) return; // a broader row would duplicate specific ones
    out.set(fk, r);
    outYmm.add(yk);
  };

  // 1) consensus from other eBay listings (exact catalog rows)
  const min = Math.max(1, c.minListings);
  for (const { row, support } of evidence.rows.sort((a, b) => b.support - a.support)) {
    if (support >= min) add({ ...row, _source: "ebay_listings", _support: String(support) });
  }

  // 2) + 3) Claude's rows, validated against eBay's catalog
  for (const r of claudeRows ?? []) {
    const src = r.source === "part_number_knowledge" ? "part_number_knowledge" : "listing_text";
    const label = `${r.year} ${r.make} ${r.model}`.trim();
    if (src === "part_number_knowledge" && (!c.allowKnowledge || r.confidence !== "high")) {
      dropped.push(`${label}: part-number knowledge ${c.allowKnowledge ? `(${r.confidence} confidence)` : "(disabled)"}`);
      continue;
    }
    const year = r.year?.trim();
    if (!year || !/^(19|20)\d\d$/.test(year) || !r.make?.trim() || !r.model?.trim()) continue;
    let v: { Year: string; Make: string; Model: string } | null | undefined = { Year: year, Make: r.make.trim(), Model: r.model.trim() };
    if (deps.validateVehicle) {
      try {
        v = await deps.validateVehicle(item.categoryId, v);
      } catch {
        v = undefined;
      }
    } else {
      v = undefined;
    }
    if (v === null) {
      dropped.push(`${label}: not in eBay's vehicle catalog`);
      continue;
    }
    if (v === undefined) {
      // couldn't verify: keep what the listing itself states, never unverified knowledge
      if (src === "part_number_knowledge") {
        dropped.push(`${label}: couldn't verify with eBay's catalog`);
        continue;
      }
      v = { Year: year, Make: r.make.trim(), Model: r.model.trim() };
    }
    add({ ...v, _source: src, _support: "" });
  }

  const rows = [...out.values()].slice(0, MAX_FITMENT_ROWS);
  return { rows, dropped };
}

/** Strip internal fields before sending rows to eBay. */
export const toCompatRows = (rows: FitmentRow[]): CompatRow[] => rows.map(pick);
