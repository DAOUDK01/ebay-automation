/** Same maths and policy rules as backend/src/lib/shipping.ts - used for live recalculation in the listing editor. */
import type { PackageDetails, ShippingPolicy } from "./types";

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function computeWeights(pkg: PackageDetails, divisor: number, minKg: number) {
  const dimensionalKg = pkg.lengthCm && pkg.widthCm && pkg.heightCm ? round((pkg.lengthCm * pkg.widthCm * pkg.heightCm) / divisor) : 0;
  const billableKg = round(Math.max(pkg.weightKg || 0, dimensionalKg));
  const categoryKg = Math.max(minKg, Math.ceil(billableKg - 1e-9));
  return { actualKg: round(pkg.weightKg || 0), dimensionalKg, billableKg, categoryKg };
}

// ---- copied from backend/src/lib/shipping.ts (keep in sync)
/**
 * Part types a shipping policy can be named after, with the ways sellers write them. A policy named with
 * any alias ("Gear Box Shipping Policy") is for that part; a listing is that part only if its title has
 * one of the aliases as a whole phrase ("Liftgate Motor and Gear" is NOT a gear box).
 */
export const PART_TYPES: { key: string; aliases: string[] }[] = [
  { key: "transmission", aliases: ["transmission", "gearbox", "gear box", "transaxle", "trans assembly"] },
  { key: "engine", aliases: ["engine", "long block", "short block", "motor assembly engine"] },
  { key: "headlight", aliases: ["headlight", "headlamp", "head light", "head lamp"] },
  { key: "taillight", aliases: ["taillight", "tail light", "taillamp", "tail lamp"] },
  { key: "door shell", aliases: ["door shell"] },
  { key: "door", aliases: ["door assembly", "door panel"] },
  { key: "bumper", aliases: ["bumper"] },
  { key: "hood", aliases: ["hood"] },
  { key: "fender", aliases: ["fender"] },
  { key: "tailgate", aliases: ["tailgate", "liftgate", "lift gate", "trunk lid", "decklid", "deck lid"] },
  { key: "transfer case", aliases: ["transfer case"] },
  { key: "differential", aliases: ["differential", "rear end", "carrier assembly"] },
  { key: "axle", aliases: ["axle assembly", "axle housing", "rear axle", "front axle"] },
  { key: "radiator", aliases: ["radiator"] },
  { key: "mirror", aliases: ["mirror"] },
  { key: "seat", aliases: ["seat"] },
  { key: "wheel", aliases: ["wheel", "rim"] },
  { key: "dashboard", aliases: ["dashboard", "dash panel", "instrument panel"] },
  { key: "windshield", aliases: ["windshield", "windscreen"] },
  { key: "steering rack", aliases: ["steering rack", "rack and pinion"] },
  { key: "turbo", aliases: ["turbo", "turbocharger"] },
  { key: "ac compressor", aliases: ["ac compressor", "a c compressor"] },
  { key: "alternator", aliases: ["alternator"] },
  { key: "starter", aliases: ["starter"] },
  { key: "catalytic converter", aliases: ["catalytic converter"] },
];

/**
 * Words that mean the listing is an accessory OF the part, not the part itself
 * ("Engine Mount", "Transmission Control Module", "Headlight Leveling Motor", "Mirror Glass").
 */
const ACCESSORY = new Set(
  (
    "mount mounts bracket brackets sensor sensors switch cover covers harness wiring wire line lines hose hoses cooler pan " +
    "gasket seal bolt bolts cable cables module computer ecu ecm pcm tcm solenoid valve filter dipstick motor motors bulb bulbs " +
    "ballast relay fuse clip clips trim cap lid plug pipe tube bushing bushings damper strut struts shock latch lock actuator " +
    "handle hinge hinges glass emblem badge molding moulding grille insert bezel weatherstrip regulator cylinder pump pulley " +
    "belt tensioner fan shroud reservoir tank bearing hub sticker decal knob lever cup bracket washer nut stud screw speaker " +
    "camera light lamp led trim"
  ).split(" "),
);

/** words that are part of the name, not an accessory, for these parts ("Engine Motor", "Headlight Lamp") */
const NOT_ACCESSORY_FOR: Record<string, string[]> = {
  engine: ["motor"],
  headlight: ["light", "lamp", "led", "bulb"],
  taillight: ["light", "lamp", "led", "bulb"],
  wheel: ["hub"],
};

const norm = (s: string) =>
  ` ${(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ")} `;

/** Part type a policy is named after: a known alias in its name, e.g. "Gear Box Shipping Policy" -> transmission. */
export function policyPartType(name: string): string | null {
  const n = norm(name);
  const hit = PART_TYPES.find((t) => t.aliases.some((a) => n.includes(` ${a} `)));
  return hit?.key ?? null;
}

/**
 * Is this listing that part (not an accessory of it)? The alias must appear in the title and the next
 * two words must not be an accessory word ("Transmission Mount" -> no, "Transmission Assembly" -> yes).
 * Some words are part of the name for certain parts (NOT_ACCESSORY_FOR), e.g. "Engine Motor Assembly".
 */
export function titleIsPart(title: string, key: string): boolean {
  const type = PART_TYPES.find((t) => t.key === key);
  if (!type) return false;
  const t = norm(title);
  const w = t.trim().split(" ");
  for (const alias of type.aliases) {
    if (!t.includes(` ${alias} `)) continue;
    const aw = alias.split(" ");
    for (let i = 0; i + aw.length <= w.length; i++) {
      if (aw.some((x, j) => w[i + j] !== x)) continue;
      const next = w.slice(i + aw.length, i + aw.length + 2);
      const ok = NOT_ACCESSORY_FOR[key] ?? [];
      const blocked = next.some((x) => ACCESSORY.has(x) && !ok.includes(x));
      if (!blocked) return true;
    }
  }
  return false;
}

/** Policy named after the part this listing is (the backend tags part policies with `parts: [type]`). */
export function partPolicyFor(policies: ShippingPolicy[], title: string) {
  return policies.find((p) => !p.copy && p.parts?.length && titleIsPart(title, p.parts[0])) ?? null;
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
