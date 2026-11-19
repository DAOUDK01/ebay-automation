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

/**
 * Classify the store's policies:
 *  - kg: weight bracket from the name ("Ground 7 KG" -> 7)
 *  - parts: [part type] when the name has a known part alias ("Gear Box Shipping Policy" -> ["transmission"])
 *  - copy: eBay duplicate ("... Copy (3)"), ignored
 */
export function withKg(list: { id: string; name: string }[]): ShippingPolicy[] {
  return list.map((p) => {
    const part = policyPartType(p.name);
    return { ...p, kg: parsePolicyKg(p.name), parts: part ? [part] : [], copy: isCopyPolicy(p.name) };
  });
}

/** A policy named after the part this listing is, e.g. the Gear Box policy for a transmission. */
export function partPolicyFor(policies: ShippingPolicy[], title: string): ShippingPolicy | null {
  return policies.find((p) => !p.copy && p.parts?.length && titleIsPart(title, p.parts[0])) ?? null;
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
  /** Claude's choice of part policy by name ("" = none); undefined = decide from the title */
  claudePart?: string,
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
  const partPolicy =
    claudePart === undefined
      ? partPolicyFor(policies, item.title ?? "")
      : (policies.find((p) => !p.copy && p.parts?.length && p.name.trim().toLowerCase() === claudePart.trim().toLowerCase()) ?? null);
  let suggested = partPolicy ?? pickPolicy(policies.filter((p) => !p.parts?.length), w.categoryKg, "", current);
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
