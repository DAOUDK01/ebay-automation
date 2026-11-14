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

export const withKg = (list: { id: string; name: string }[]): ShippingPolicy[] =>
  list.map((p) => ({ ...p, kg: parsePolicyKg(p.name) }));

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

export function pickPolicy(policies: ShippingPolicy[], categoryKg: number) {
  const brackets = policies.filter((p) => p.kg !== null).sort((a, b) => a.kg! - b.kg!);
  return brackets.find((p) => p.kg! >= categoryKg) ?? null;
}

export function analyzeShipping(
  item: Pick<EbayItem, "shipping">,
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
  const overMax = w.categoryKg > s.maxKg;
  const brackets = policies.filter((p) => p.kg !== null);
  let suggested = pickPolicy(policies, w.categoryKg);
  if (!suggested && overMax && brackets.length) suggested = [...brackets].sort((a, b) => b.kg! - a.kg!)[0];

  const matches = Boolean(current && suggested && (current.id ? current.id === suggested.id : current.name === suggested.name));
  let note: string;
  if (!brackets.length) note = "No weight-based shipping policies found (policy names need a weight like '7 KG')";
  else if (overMax) note = `Billable weight ${w.billableKg} kg is over your ${s.maxKg} kg maximum - consider freight`;
  else if (!suggested) note = `No policy for ${w.categoryKg} kg`;
  else if (matches) note = `Correct policy (${w.categoryKg} kg bracket)`;
  else if (current?.kg != null && suggested.kg != null) {
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
    current,
    suggested,
    matches,
    note,
  };
}
