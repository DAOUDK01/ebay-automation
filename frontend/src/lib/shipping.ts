/** Same maths and policy rules as backend/src/lib/shipping.ts - used for live recalculation in the listing editor. */
import type { PackageDetails, ShippingPolicy } from "./types";

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function computeWeights(pkg: PackageDetails, divisor: number, minKg: number) {
  const dimensionalKg = pkg.lengthCm && pkg.widthCm && pkg.heightCm ? round((pkg.lengthCm * pkg.widthCm * pkg.heightCm) / divisor) : 0;
  const billableKg = round(Math.max(pkg.weightKg || 0, dimensionalKg));
  const categoryKg = Math.max(minKg, Math.ceil(billableKg - 1e-9));
  return { actualKg: round(pkg.weightKg || 0), dimensionalKg, billableKg, categoryKg };
}

const stem = (w: string) => {
  const x = w.toLowerCase();
  if (x.length > 4 && x.endsWith("ies")) return x.slice(0, -3) + "y";
  if (x.length > 3 && x.endsWith("s") && !x.endsWith("ss")) return x.slice(0, -1);
  return x;
};
const words = (s: string) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stem);

/** Policy named after a part in the title (the backend fills `parts` from the policy name). */
export function partPolicyFor(policies: ShippingPolicy[], title: string) {
  const t = new Set(words(title));
  return (
    policies
      .filter((p) => !p.copy && p.parts?.length && p.parts.every((w) => t.has(w)))
      .sort((a, b) => b.parts!.length - a.parts!.length)[0] ?? null
  );
}

export const weightBrackets = (policies: ShippingPolicy[]) =>
  policies.filter((p) => p.kg !== null && !p.copy && !p.parts?.length).sort((a, b) => a.kg! - b.kg!);

/** Part-name policy first, else the smallest weight bracket that fits (keeping the current one if it's the same weight). */
export function pickPolicy(policies: ShippingPolicy[], categoryKg: number, title = "", current?: ShippingPolicy | null, hasWeight = true) {
  const part = title ? partPolicyFor(policies, title) : null;
  if (part) return part;
  if (!hasWeight) return null;
  const best = weightBrackets(policies).find((p) => p.kg! >= categoryKg) ?? null;
  if (best && current && current.kg === best.kg && !current.parts?.length) return current;
  return best;
}

export const kg = (n: number | null | undefined) => (n || n === 0 ? `${Number(n.toFixed(2))} kg` : "—");
