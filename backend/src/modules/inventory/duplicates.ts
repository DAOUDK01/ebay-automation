/**
 * Duplicate listings: the same item listed more than once in one store.
 * Listings are grouped when they share a SKU, an identical title, or a part number in the title
 * (union of all three, so A~B by SKU and B~C by title puts A, B, C in one group).
 * Pure functions here; routes do the database and the eBay calls.
 */
import { createHash } from "node:crypto";
import { Schema, model } from "mongoose";
import { extractPartNumbers } from "../../lib/fitment";

/** Groups the seller marked "not duplicates" (by group key). */
const ignoreSchema = new Schema(
  { storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true }, key: { type: String, required: true } },
  { timestamps: true },
);
ignoreSchema.index({ storeId: 1, key: 1 }, { unique: true });
export const DuplicateIgnore = model("InvDuplicateIgnore", ignoreSchema);

export interface DupListing {
  itemId: string;
  title: string;
  sku?: string | null;
  price?: number | null;
  quantitySold?: number | null;
  watchCount?: number | null;
  imageUrl?: string | null;
  quantityAvailable?: number | null;
  startTime?: Date | string | null;
  listingType?: string | null;
}

export type DupReason = "sku" | "title" | "part_number";

export interface DupGroup {
  /** stable id of the group (hash of its item ids) - used to ignore a group */
  key: string;
  reasons: DupReason[];
  /** high = same SKU or identical title; medium = only a shared part number */
  confidence: "high" | "medium";
  /** shared values that linked them, e.g. ["SKU A-12", "PN 33150-TBA-A01"] */
  matches: string[];
  keepItemId: string;
  listings: DupListing[];
}

export const normTitle = (t: string) =>
  (t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const normPn = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Part numbers in a title, normalized. Adds all-digit OEM numbers (BMW 11 digits, GM 8 digits...) that the
 * fitment extractor skips; year ranges and short numbers are not part numbers.
 */
export function titlePartNumbers(title: string): string[] {
  const out = new Set(extractPartNumbers({ title, itemSpecifics: {} }).map(normPn));
  for (const m of (title || "").match(/\b\d{8,13}\b/g) ?? []) out.add(m);
  return [...out];
}

/** sold out = known to have 0 available */
const soldOut = (l: DupListing) => l.quantityAvailable === 0;

/** Which listing of a group to keep: still in stock, most sold, most watched, has a photo, then the oldest. */
export function keepOrder(a: DupListing, b: DupListing) {
  return (
    Number(soldOut(a)) - Number(soldOut(b)) ||
    (b.quantitySold ?? 0) - (a.quantitySold ?? 0) ||
    (b.watchCount ?? 0) - (a.watchCount ?? 0) ||
    Number(!!b.imageUrl) - Number(!!a.imageUrl) ||
    (a.startTime ? new Date(a.startTime).getTime() : Infinity) - (b.startTime ? new Date(b.startTime).getTime() : Infinity) ||
    a.itemId.localeCompare(b.itemId)
  );
}

export const groupKey = (itemIds: string[]) => createHash("sha1").update([...itemIds].sort().join(",")).digest("hex").slice(0, 16);

export function findDuplicates(rows: DupListing[], ignored: Set<string> = new Set()): DupGroup[] {
  // union-find over listing indexes
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const buckets = new Map<string, number[]>();
  const add = (key: string, i: number) => {
    const list = buckets.get(key) ?? [];
    list.push(i);
    buckets.set(key, list);
  };
  rows.forEach((r, i) => {
    const sku = (r.sku ?? "").trim().toUpperCase();
    if (sku) add(`sku:${sku}`, i);
    const t = normTitle(r.title);
    if (t.length >= 8) add(`title:${t}`, i);
    for (const pn of titlePartNumbers(r.title)) add(`pn:${pn}`, i);
  });
  // a part number shared by a huge number of listings is a generic token, not an identity
  for (const [key, idx] of buckets) if (idx.length > 1 && !(key.startsWith("pn:") && idx.length > 25)) idx.forEach((i) => union(idx[0], i));

  const groups = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });

  const out: DupGroup[] = [];
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const members = idx.map((i) => rows[i]);
    const key = groupKey(members.map((m) => m.itemId));
    if (ignored.has(key)) continue;
    const reasons = new Set<DupReason>();
    const matches: string[] = [];
    for (const [bk, bIdx] of buckets) {
      const inGroup = bIdx.filter((i) => idx.includes(i));
      if (inGroup.length < 2) continue;
      if (bk.startsWith("sku:")) {
        reasons.add("sku");
        matches.push(`SKU ${bk.slice(4)}`);
      } else if (bk.startsWith("title:")) {
        reasons.add("title"); // shown as a badge; no extra text needed
      } else if (!(bIdx.length > 25)) {
        reasons.add("part_number");
        matches.push(`Part # ${bk.slice(3)}`);
      }
    }
    if (!reasons.size) continue;
    const sorted = [...members].sort(keepOrder);
    out.push({
      key,
      reasons: [...reasons],
      confidence: reasons.has("sku") || reasons.has("title") ? "high" : "medium",
      matches: matches.slice(0, 6),
      keepItemId: sorted[0].itemId,
      listings: sorted,
    });
  }
  return out.sort((a, b) => Number(b.confidence === "high") - Number(a.confidence === "high") || b.listings.length - a.listings.length);
}

/**
 * Safety check for ending: refuse a selection that would end every listing of a group
 * (returns the offending group keys).
 */
export function wouldEndWholeGroup(groups: DupGroup[], itemIds: string[]): string[] {
  const ending = new Set(itemIds);
  return groups.filter((g) => g.listings.every((l) => ending.has(l.itemId))).map((g) => g.key);
}
