/**
 * Shipping weight analysis.
 *   dimensional kg = L x W x H (cm) / divisor   (5000 is the common carrier divisor; some use 6000)
 *   billable kg    = max(actual, dimensional)
 *   bracket        = billable rounded UP to a whole kg, never below the store minimum (3 kg)
 * The store's shipping policies are weight brackets named like "Ground 7 KG"; the suggested policy is the
 * smallest bracket >= the item's bracket.
 */
import type { StoreSettings } from "../models/Store";
import type { EbayItem, PackageDetails, ShippingAnalysis, ShippingPolicy } from "./ebay/types";

/** "UPS Ground 7 KG" -> 7, "5-10kg" -> 10, "3 kilos" -> 3, "Free shipping" -> null */
export function parsePolicyKg(name: string): number | null {
  const range = name.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilos?|kilograms?)\b/i);
  if (range) return Number(range[2]);
  const single = name.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilos?|kilograms?)\b/i);
  return single ? Number(single[1]) : null;
}

/** Duplicates made with eBay's "copy policy" (e.g. "3 KG Copy (3)") are never suggested. */
export const isCopyPolicy = (name: string) => /\bcopy\b/i.test(name);

/** Words that describe the carrier/service rather than a part. */
const GENERIC_WORDS = new Set(
  (
    "shipping ship shipment policy policies profile rate rates rule kg kgs kilo kilos kilogram kilograms copy ups usps fedex dhl " +
    "ground freight free standard express economy priority international intl domestic service flat calculated weight based " +
    "the for and of to with up from parts part auto item items only local pickup heavy light small medium large oversize " +
    "oversized ltl global worldwide usa us uk new used oem box package packet parcel delivery fast business day days"
  ).split(" "),
);

/** singular, lowercase: "Headlights" -> "headlight", "Bumpers" -> "bumper", "Axles" -> "axle" */
const stem = (w: string) => {
  const x = w.toLowerCase();
  if (x.length > 4 && x.endsWith("ies")) return x.slice(0, -3) + "y";
  if (x.length > 3 && x.endsWith("s") && !x.endsWith("ss")) return x.slice(0, -1);
  return x;
};

/** Words of a title/name, stemmed. */
const words = (s: string) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stem);

/**
 * Classify the store's policies:
 *  - kg: weight bracket from the name ("Ground 7 KG" -> 7)
 *  - parts: part words left after removing carrier/weight words and words shared by most policies
 *    (e.g. the store prefix "BLAP"); "BLAP Engine shipping policy" -> ["engine"]
 *  - copy: eBay duplicate ("... Copy (3)"), ignored
 */
export function withKg(list: { id: string; name: string }[]): ShippingPolicy[] {
  const tokens = list.map((p) => new Set(words(p.name)));
  const share = new Map<string, number>();
  for (const t of tokens) for (const w of t) share.set(w, (share.get(w) ?? 0) + 1);
  const common = (w: string) => list.length >= 4 && (share.get(w) ?? 0) >= list.length * 0.5;
  return list.map((p, i) => {
    const parts = [...tokens[i]].filter((w) => w.length >= 3 && !/\d/.test(w) && !GENERIC_WORDS.has(w) && !common(w));
    return { ...p, kg: parsePolicyKg(p.name), parts, copy: isCopyPolicy(p.name) };
  });
}

/** A policy named after a part this listing is ("Engine policy" for an engine): all its part words in the title. */
export function partPolicyFor(policies: ShippingPolicy[], title: string): ShippingPolicy | null {
  const t = new Set(words(title));
  const hits = policies
    .filter((p) => !p.copy && p.parts?.length && p.parts.every((w) => t.has(w)))
    .sort((a, b) => b.parts!.length - a.parts!.length);
  return hits[0] ?? null;
}

export interface ShippingEstimate {
  weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  basis: string;
  confidence: "low" | "medium" | "high";
}

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** The core maths, shared by the pipeline and the listing editor's live preview. */
export function computeWeights(pkg: PackageDetails, divisor: number, minKg: number) {
  const dimensionalKg = pkg.lengthCm && pkg.widthCm && pkg.heightCm ? round((pkg.lengthCm * pkg.widthCm * pkg.heightCm) / divisor) : 0;
  const billableKg = round(Math.max(pkg.weightKg || 0, dimensionalKg));
  const categoryKg = Math.max(minKg, Math.ceil(billableKg - 1e-9));
  return { actualKg: round(pkg.weightKg || 0), dimensionalKg, billableKg, categoryKg };
}

/** Plain weight brackets: have a kg, aren't copies and aren't tied to a part. */
export const weightBrackets = (policies: ShippingPolicy[]) =>
  policies.filter((p) => p.kg !== null && !p.copy && !p.parts?.length).sort((a, b) => a.kg! - b.kg!);

/**
 * Policy for this item: a part-name policy if one fits the title, else the smallest weight bracket that
 * covers the item. If the current policy is already a correct choice (same part policy, or a bracket of
 * the same weight) it is kept.
 */
export function pickPolicy(policies: ShippingPolicy[], categoryKg: number, title = "", current?: ShippingPolicy | null) {
  const part = title ? partPolicyFor(policies, title) : null;
  if (part) return part;
  const brackets = weightBrackets(policies);
  const best = brackets.find((p) => p.kg! >= categoryKg) ?? null;
  if (best && current && current.kg === best.kg && !current.parts?.length) return current;
  return best;
}

export function analyzeShipping(
  item: Pick<EbayItem, "shipping"> & { title?: string },
  estimate: ShippingEstimate | undefined,
  policies: ShippingPolicy[],
  s: StoreSettings["modules"]["shipping"],
): ShippingAnalysis {
  const listingPkg = item.shipping?.package;
  const est: PackageDetails | undefined =
    s.useEstimates && estimate && estimate.weight_kg > 0
      ? { weightKg: estimate.weight_kg, lengthCm: estimate.length_cm, widthCm: estimate.width_cm, heightCm: estimate.height_cm }
      : undefined;

  // prefer what the listing says; fill missing weight/dimensions from the estimate
  let source: ShippingAnalysis["source"] = "none";
  let pkg: PackageDetails | undefined;
  if (listingPkg && listingPkg.weightKg > 0) {
    source = "listing";
    const hasDims = listingPkg.lengthCm > 0 && listingPkg.widthCm > 0 && listingPkg.heightCm > 0;
    pkg = hasDims || !est ? listingPkg : { ...listingPkg, lengthCm: est.lengthCm, widthCm: est.widthCm, heightCm: est.heightCm };
  } else if (est) {
    source = "estimate";
    pkg = listingPkg?.lengthCm && listingPkg.widthCm && listingPkg.heightCm ? { ...est, ...listingPkg, weightKg: est.weightKg } : est;
  }

  const current = item.shipping?.policyId
    ? policies.find((p) => p.id === item.shipping.policyId) ?? { id: item.shipping.policyId, name: item.shipping.policy, kg: parsePolicyKg(item.shipping.policy ?? "") }
    : item.shipping?.policy
      ? policies.find((p) => p.name === item.shipping.policy) ?? { id: "", name: item.shipping.policy, kg: parsePolicyKg(item.shipping.policy) }
      : null;

  if (!pkg) {
    return {
      source: "none", actualKg: 0, dimensionalKg: 0, divisor: s.divisor, billableKg: 0, categoryKg: 0, overMax: false,
      current, suggested: null, matches: false,
      note: "No package weight on the listing and no estimate - add weight & size on the listing's Edit page",
    };
  }

  const w = computeWeights(pkg, s.divisor, s.minKg);
  // the heaviest policy the store actually has counts as the maximum too (e.g. a 70 kg policy with max 60)
  const maxPolicyKg = Math.max(0, ...weightBrackets(policies).map((p) => p.kg!));
  const limitKg = Math.max(s.maxKg, maxPolicyKg);
  const overMax = w.categoryKg > limitKg;
  const brackets = weightBrackets(policies);
  const partPolicy = partPolicyFor(policies, item.title ?? "");
  let suggested = pickPolicy(policies, w.categoryKg, item.title ?? "", current);
  if (!suggested && overMax && brackets.length) suggested = brackets[brackets.length - 1];

  const same = (a: ShippingPolicy | null, b: ShippingPolicy | null) => Boolean(a && b && (a.id && b.id ? a.id === b.id : a.name === b.name));
  const matches = same(current, suggested);
  let note: string;
  if (partPolicy) {
    note = matches
      ? `Correct policy - "${partPolicy.name}" is the policy for this part`
      : `This is a ${partPolicy.parts!.join(" ")} - use the "${partPolicy.name}" policy`;
  } else if (!brackets.length) note = "No weight-based shipping policies found (policy names need a weight like '7 KG')";
  else if (overMax)
    note =
      suggested && current?.kg != null && suggested.kg != null && current.kg < suggested.kg
        ? `Billable weight ${w.billableKg} kg is over your largest policy (${limitKg} kg) - moving to the ${suggested.kg} kg policy, consider freight`
        : `Billable weight ${w.billableKg} kg is over your largest policy (${limitKg} kg) - consider freight`;
  else if (!suggested) note = `No policy for ${w.categoryKg} kg`;
  else if (matches) note = `Correct policy (${w.categoryKg} kg bracket)`;
  else if (current?.parts?.length) note = `Current policy is for ${current.parts.join(" ")} parts - this item should use the ${suggested.kg} kg policy`;
  else if (current?.kg != null && suggested.kg != null && current.kg !== suggested.kg) {
    note =
      current.kg > suggested.kg
        ? `Current policy is ${current.kg} kg - item only needs ${suggested.kg} kg (buyers are overcharged)`
        : `Current policy is ${current.kg} kg - item needs ${suggested.kg} kg (you are undercharging)`;
  } else note = `Should use the ${suggested.kg} kg policy`;

  return {
    source,
    confidence: source === "estimate" ? estimate?.confidence : undefined,
    basis: source === "estimate" ? estimate?.basis : undefined,
    package: pkg,
    ...w,
    divisor: s.divisor,
    overMax,
    rule: partPolicy ? "part" : "weight",
    current,
    suggested,
    matches,
    note,
  };
}
