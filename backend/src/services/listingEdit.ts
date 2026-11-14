/** Manual edits from the listing page -> eBay revise. Only fields that actually changed are sent. */
import type { CompatRow, EbayItem, ListingChanges, PackageDetails, Specifics } from "../lib/ebay/types";

export interface ManualEdit {
  title?: string;
  price?: number;
  /** quantity AVAILABLE as shown to the user (eBay's <Quantity> = available + sold) */
  quantityAvailable?: number;
  description?: string;
  itemSpecifics?: Specifics;
  compatibility?: CompatRow[];
  shippingPolicyId?: string;
  /** package weight (kg) and box size (cm) */
  packageDetails?: PackageDetails;
}

export const MAX_COMPAT_ROWS = 3000;
const FIELDS = ["Year", "Make", "Model", "Trim", "Engine"] as const;
const rowKey = (r: CompatRow) => FIELDS.map((f) => (r[f] ?? "").trim().toLowerCase()).join("|");

function cleanSpecifics(s: Specifics): Specifics {
  const out: Specifics = {};
  for (const [rawName, vals] of Object.entries(s)) {
    const name = rawName.trim();
    const values = [...new Set(vals.map((v) => v.trim()).filter(Boolean))];
    if (name && values.length) out[name] = values;
  }
  return out;
}

function cleanCompat(rows: CompatRow[]): CompatRow[] {
  const seen = new Set<string>();
  const out: CompatRow[] = [];
  for (const r of rows) {
    const row: CompatRow = {};
    for (const f of FIELDS) if (r[f]?.trim()) row[f] = r[f].trim();
    if (!row.Year || !row.Make || !row.Model) continue;
    const k = rowKey(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

const sameSpecifics = (a: Specifics, b: Specifics) => {
  const norm = (s: Specifics) =>
    JSON.stringify(
      Object.entries(s)
        .map(([k, v]) => [k.toLowerCase(), [...v].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return norm(a) === norm(b);
};

const sameCompat = (a: CompatRow[], b: CompatRow[]) => {
  const ka = a.map(rowKey).sort();
  const kb = cleanCompat(b).map(rowKey).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

/** Validate + diff. Throws Error(message) for invalid input. */
export function computeManualChanges(before: EbayItem, edit: ManualEdit): ListingChanges {
  const changes: ListingChanges = {};

  if (edit.title !== undefined) {
    const t = edit.title.replace(/\s+/g, " ").trim();
    if (!t) throw new Error("Title can't be empty");
    if (t.length > 80) throw new Error(`Title is ${t.length} characters - eBay allows 80`);
    if (t !== before.title.trim()) changes.title = t;
  }

  if (edit.price !== undefined) {
    if (before.hasVariations) throw new Error("This listing has variations - change variation prices on eBay");
    if (!(edit.price > 0)) throw new Error("Price must be greater than 0");
    const p = Math.round(edit.price * 100) / 100;
    if (Math.abs(p - before.price) >= 0.005) changes.price = p;
  }

  if (edit.quantityAvailable !== undefined) {
    if (before.hasVariations) throw new Error("This listing has variations - change variation quantities on eBay");
    const q = Math.floor(edit.quantityAvailable);
    if (!(q >= 0)) throw new Error("Quantity can't be negative");
    const total = q + (before.quantitySold ?? 0);
    if (total !== before.quantity) changes.quantity = total;
  }

  if (edit.description !== undefined) {
    if (edit.description.length > 500_000) throw new Error("Description is too long (max 500,000 characters)");
    if (edit.description !== (before.descriptionHtml ?? "")) changes.description = edit.description;
  }

  if (edit.itemSpecifics !== undefined) {
    const specs = cleanSpecifics(edit.itemSpecifics);
    if (Object.keys(specs).length > 45) throw new Error("eBay allows at most 45 item specifics");
    for (const [name, vals] of Object.entries(specs)) {
      if (name.length > 65) throw new Error(`Item specific name too long: "${name.slice(0, 40)}…" (max 65)`);
      const long = vals.find((v) => v.length > 65);
      if (long) throw new Error(`Value for "${name}" is longer than 65 characters`);
    }
    if (!sameSpecifics(specs, before.itemSpecifics)) changes.itemSpecifics = specs;
  }

  if (edit.compatibility !== undefined) {
    const rows = cleanCompat(edit.compatibility);
    if (rows.length > MAX_COMPAT_ROWS) throw new Error(`Too many compatibility rows (${rows.length}, max ${MAX_COMPAT_ROWS})`);
    const current = before.compatibilityAll ?? before.compatibilitySample ?? [];
    if (!sameCompat(rows, current)) changes.compatibilityReplace = rows;
  }

  if (edit.shippingPolicyId !== undefined && edit.shippingPolicyId && edit.shippingPolicyId !== before.shipping?.policyId) {
    changes.shippingPolicyId = edit.shippingPolicyId;
  }

  if (edit.packageDetails !== undefined) {
    const p = edit.packageDetails;
    for (const [k, v] of Object.entries(p)) {
      if (!(v >= 0) || v > 2000) throw new Error(`Invalid package ${k.replace(/Kg|Cm/, "")}: ${v}`);
    }
    if (!(p.weightKg > 0)) throw new Error("Package weight must be greater than 0");
    const cur = before.shipping?.package;
    const same =
      cur &&
      Math.abs(cur.weightKg - p.weightKg) < 0.01 &&
      Math.ceil(cur.lengthCm) === Math.ceil(p.lengthCm) &&
      Math.ceil(cur.widthCm) === Math.ceil(p.widthCm) &&
      Math.ceil(cur.heightCm) === Math.ceil(p.heightCm);
    if (!same) changes.packageDetails = p;
  }

  return changes;
}
