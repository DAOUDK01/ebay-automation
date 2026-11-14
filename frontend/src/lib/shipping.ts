/** Same maths as backend/src/lib/shipping.ts - used for live recalculation in the listing editor. */
import type { PackageDetails, ShippingPolicy } from "./types";

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function computeWeights(pkg: PackageDetails, divisor: number, minKg: number) {
  const dimensionalKg = pkg.lengthCm && pkg.widthCm && pkg.heightCm ? round((pkg.lengthCm * pkg.widthCm * pkg.heightCm) / divisor) : 0;
  const billableKg = round(Math.max(pkg.weightKg || 0, dimensionalKg));
  const categoryKg = Math.max(minKg, Math.ceil(billableKg - 1e-9));
  return { actualKg: round(pkg.weightKg || 0), dimensionalKg, billableKg, categoryKg };
}

export function pickPolicy(policies: ShippingPolicy[], categoryKg: number) {
  return (
    policies
      .filter((p) => p.kg !== null)
      .sort((a, b) => a.kg! - b.kg!)
      .find((p) => p.kg! >= categoryKg) ?? null
  );
}

export const kg = (n: number | null | undefined) => (n || n === 0 ? `${Number(n.toFixed(2))} kg` : "—");
