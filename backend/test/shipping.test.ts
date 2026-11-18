import assert from "node:assert/strict";
import { test } from "node:test";
import { XMLParser } from "fast-xml-parser";
import { buildReviseXml, parsePackage } from "../src/lib/ebay/trading";
import type { EbayItem } from "../src/lib/ebay/types";
import { analyzeShipping, computeWeights, parsePolicyKg, withKg } from "../src/lib/shipping";
import { DEFAULT_SETTINGS } from "../src/models/Store";
import { computeManualChanges } from "../src/services/listingEdit";

const S = DEFAULT_SETTINGS.modules.shipping; // divisor 5000, min 3, max 60
const POLICIES = withKg(
  [1, 2, 3, 4, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60].map((k) => ({ id: `P${k}`, name: `UPS Ground ${k} KG` })).concat([{ id: "LOCAL", name: "Local pickup" }]),
);
const item = (pkg?: any, policyId = "P3", policy = "UPS Ground 3 KG") => ({ shipping: { options: [], dispatchDays: "2", policy, policyId, location: "", package: pkg } }) as Pick<EbayItem, "shipping">;

test("policy names -> kg bracket", () => {
  assert.equal(parsePolicyKg("UPS Ground 7 KG"), 7);
  assert.equal(parsePolicyKg("Heavy 25kg"), 25);
  assert.equal(parsePolicyKg("5-10 kg parcels"), 10);
  assert.equal(parsePolicyKg("3 kilos"), 3);
  assert.equal(parsePolicyKg("Freight 2.5 Kgs"), 2.5);
  assert.equal(parsePolicyKg("Local pickup"), null);
});

test("weights: dimensional, billable, rounded-up bracket with 3 kg minimum", () => {
  // 120 x 90 x 30 cm door shell box = 324000 / 5000 = 64.8 kg dimensional
  assert.deepEqual(computeWeights({ weightKg: 22, lengthCm: 120, widthCm: 90, heightCm: 30 }, 5000, 3), {
    actualKg: 22, dimensionalKg: 64.8, billableKg: 64.8, categoryKg: 65,
  });
  // small sensor: 0.4 kg, 20x15x10 -> 0.6 dim -> bracket min 3
  assert.equal(computeWeights({ weightKg: 0.4, lengthCm: 20, widthCm: 15, heightCm: 10 }, 5000, 3).categoryKg, 3);
  // exactly 7.0 stays 7, 7.01 goes to 8
  assert.equal(computeWeights({ weightKg: 7, lengthCm: 0, widthCm: 0, heightCm: 0 }, 5000, 3).categoryKg, 7);
  assert.equal(computeWeights({ weightKg: 7.01, lengthCm: 0, widthCm: 0, heightCm: 0 }, 5000, 3).categoryKg, 8);
  // divisor 6000 makes dimensional weight smaller
  assert.equal(computeWeights({ weightKg: 1, lengthCm: 60, widthCm: 50, heightCm: 40 }, 6000, 3).dimensionalKg, 20);
});

test("analysis: listing package wins, suggests smallest bracket >= weight, flags over/undercharging", () => {
  // mirror: 4.2 kg actual, 55x40x35 = 15.4 kg dimensional -> bracket 16 -> next policy 20 kg
  const a = analyzeShipping(item({ weightKg: 4.2, lengthCm: 55, widthCm: 40, heightCm: 35 }), undefined, POLICIES, S);
  assert.equal(a.source, "listing");
  assert.equal(a.dimensionalKg, 15.4);
  assert.equal(a.categoryKg, 16);
  assert.equal(a.suggested?.id, "P20");
  assert.equal(a.matches, false);
  assert.match(a.note, /needs 20 kg \(you are undercharging\)/);

  // light part on the 10 kg policy -> overcharging, suggest 3 kg minimum
  const b = analyzeShipping(item({ weightKg: 1.1, lengthCm: 20, widthCm: 20, heightCm: 10 }, "P10", "UPS Ground 10 KG"), undefined, POLICIES, S);
  assert.equal(b.categoryKg, 3);
  assert.equal(b.suggested?.id, "P3");
  assert.match(b.note, /overcharged/);

  // correct already
  const c = analyzeShipping(item({ weightKg: 2.5, lengthCm: 30, widthCm: 20, heightCm: 15 }), undefined, POLICIES, S);
  assert.equal(c.matches, true);

  // over 60 kg -> flagged, largest policy suggested
  const d = analyzeShipping(item({ weightKg: 30, lengthCm: 150, widthCm: 100, heightCm: 40 }), undefined, POLICIES, S);
  assert.equal(d.overMax, true);
  assert.equal(d.suggested?.id, "P60");
  assert.match(d.note, /freight/);
});

test("analysis: estimate used when the listing has no package; low-confidence handling; none", () => {
  const est = { weight_kg: 18, length_cm: 110, width_cm: 80, height_cm: 25, basis: "door shell in large box", confidence: "medium" as const };
  const a = analyzeShipping(item(undefined), est, POLICIES, S);
  assert.equal(a.source, "estimate");
  assert.equal(a.dimensionalKg, 44);
  assert.equal(a.suggested?.id, "P50");
  assert.equal(a.basis, "door shell in large box");
  // listing weight but no box size -> box size taken from the estimate, still "listing"
  const b = analyzeShipping(item({ weightKg: 20, lengthCm: 0, widthCm: 0, heightCm: 0 }), est, POLICIES, S);
  assert.equal(b.source, "listing");
  assert.equal(b.dimensionalKg, 44);
  // estimates disabled + no package -> nothing to analyse
  const c = analyzeShipping(item(undefined), est, POLICIES, { ...S, useEstimates: false });
  assert.equal(c.source, "none");
  assert.equal(c.suggested, null);
});

test("eBay package details: English (lbs/oz, inches) and Metric parse to kg/cm", () => {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });
  const eng = p.parse(
    `<S><MeasurementUnit>English</MeasurementUnit><PackageDepth unit="inches">10</PackageDepth><PackageLength unit="inches">20</PackageLength>` +
      `<PackageWidth unit="inches">15</PackageWidth><WeightMajor unit="lbs">10</WeightMajor><WeightMinor unit="oz">8</WeightMinor></S>`,
  ).S;
  assert.deepEqual(parsePackage(eng), { weightKg: 4.76, lengthCm: 50.8, widthCm: 38.1, heightCm: 25.4 });
  const met = p.parse(
    `<S><MeasurementUnit>Metric</MeasurementUnit><PackageDepth unit="cm">30</PackageDepth><PackageLength unit="cm">120</PackageLength>` +
      `<PackageWidth unit="cm">90</PackageWidth><WeightMajor unit="kg">22</WeightMajor><WeightMinor unit="gm">500</WeightMinor></S>`,
  ).S;
  assert.deepEqual(parsePackage(met), { weightKg: 22.5, lengthCm: 120, widthCm: 90, heightCm: 30 });
  assert.equal(parsePackage(undefined), undefined);
});

test("revise XML + manual edits for shipping policy and package", () => {
  const xml = buildReviseXml("1", { shippingPolicyId: "P20", packageDetails: { weightKg: 4.25, lengthCm: 55, widthCm: 40.2, heightCm: 35 } });
  assert.match(xml, /<SellerProfiles><SellerShippingProfile><ShippingProfileID>P20<\/ShippingProfileID>/);
  assert.match(xml, /<PackageWidth unit="cm">41<\/PackageWidth>/, "dimensions rounded up");
  assert.match(xml, /<WeightMajor unit="kg">4<\/WeightMajor><WeightMinor unit="gm">250<\/WeightMinor>/);

  const before = { ...(item({ weightKg: 4.2, lengthCm: 55, widthCm: 40, heightCm: 35 }) as any), title: "t", price: 1, quantity: 1, quantitySold: 0, hasVariations: false, itemSpecifics: {} } as EbayItem;
  assert.deepEqual(computeManualChanges(before, { shippingPolicyId: "P3", packageDetails: { weightKg: 4.2, lengthCm: 55, widthCm: 40, heightCm: 35 } }), {});
  const c = computeManualChanges(before, { shippingPolicyId: "P20", packageDetails: { weightKg: 5, lengthCm: 55, widthCm: 40, heightCm: 35 } });
  assert.equal(c.shippingPolicyId, "P20");
  assert.equal(c.packageDetails?.weightKg, 5);
  assert.throws(() => computeManualChanges(before, { packageDetails: { weightKg: 0, lengthCm: 1, widthCm: 1, heightCm: 1 } }), /weight/);
});

// the store's real naming: shared "BLAP" prefix, eBay "Copy (n)" duplicates, part-name policies
const BLAP = withKg([
  ...[1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 60].map((k) => ({ id: `B${k}`, name: `BLAP shipping policy ${k} KG` })),
  { id: "B3c", name: "BLAP shipping policy 3 KG Copy (3)" },
  { id: "B5c", name: "BLAP shipping policy 5 KG Copy" },
  { id: "ENG", name: "BLAP Engine shipping policy" },
  { id: "HL", name: "BLAP Headlight Policy" },
  { id: "DOOR", name: "BLAP Door Shell policy 60 KG" },
]);
const listing = (title: string, pkg: any, policyId: string, policy: string) =>
  ({ title, shipping: { options: [], dispatchDays: "2", policy, policyId, location: "", package: pkg } }) as any;

test("policies: copies ignored, store prefix not a part, part words found", () => {
  const by = (id: string) => BLAP.find((p) => p.id === id)!;
  assert.equal(by("B3c").copy, true);
  assert.deepEqual(by("B3").parts, [], "BLAP is shared by most names -> not a part word");
  assert.deepEqual(by("ENG").parts, ["engine"]);
  assert.deepEqual(by("HL").parts, ["headlight"]);
  assert.deepEqual(by("DOOR").parts, ["door", "shell"]);
});

test("same weight bracket is correct - never switch to a Copy, no 'undercharging' message", () => {
  const a = analyzeShipping(listing("Audi A4 Door Lock Cable 4H0837099B OEM Used", { weightKg: 0.25, lengthCm: 20, widthCm: 15, heightCm: 5 }, "B3", "BLAP shipping policy 3 KG"), undefined, BLAP, S);
  assert.equal(a.suggested?.id, "B3");
  assert.equal(a.matches, true);
  assert.match(a.note, /^Correct policy/);
  // currently on the 5 kg Copy -> suggest the real 3 kg policy, not "3 KG Copy (3)"
  const b = analyzeShipping(listing("Audi A4 Door Lock Cable", { weightKg: 0.25, lengthCm: 20, widthCm: 15, heightCm: 5 }, "B5c", "BLAP shipping policy 5 KG Copy"), undefined, BLAP, S);
  assert.equal(b.suggested?.id, "B3");
  assert.match(b.note, /overcharged/);
});

test("part policies win over weight: engine -> Engine policy, headlights -> Headlight policy", () => {
  const eng = analyzeShipping(listing("2015-2018 Ford F150 5.0L Engine Motor Assembly OEM Used", { weightKg: 180, lengthCm: 100, widthCm: 80, heightCm: 80 }, "B60", "BLAP shipping policy 60 KG"), undefined, BLAP, S);
  assert.equal(eng.suggested?.id, "ENG");
  assert.equal(eng.rule, "part");
  assert.match(eng.note, /use the "BLAP Engine shipping policy" policy/);
  const hl = analyzeShipping(listing("2016-2021 Honda Civic Left Headlights OEM Used", { weightKg: 4, lengthCm: 60, widthCm: 40, heightCm: 35 }, "HL", "BLAP Headlight Policy"), undefined, BLAP, S);
  assert.equal(hl.suggested?.id, "HL");
  assert.equal(hl.matches, true);
  // "Door" alone is not enough for "Door Shell"
  const door = analyzeShipping(listing("Audi A4 Front Left Door Lock Actuator", { weightKg: 0.8, lengthCm: 25, widthCm: 20, heightCm: 15 }, "B3", "BLAP shipping policy 3 KG"), undefined, BLAP, S);
  assert.equal(door.rule, "weight");
  assert.equal(door.suggested?.id, "B3");
  // a part policy on a non-matching item is switched back to a weight bracket
  const wrong = analyzeShipping(listing("Audi A4 Door Lock Actuator", { weightKg: 0.8, lengthCm: 25, widthCm: 20, heightCm: 15 }, "ENG", "BLAP Engine shipping policy"), undefined, BLAP, S);
  assert.equal(wrong.suggested?.id, "B3");
  assert.match(wrong.note, /for engine parts/);
});

test("heavy item over every policy: moved UP to the largest policy and pushed by default", async () => {
  const { buildChanges } = await import("../src/services/pipeline");
  const pols = withKg([3, 5, 10, 20, 30, 40, 60, 70].map((k) => ({ id: `P${k}`, name: `BLAP shipping policy ${k}kg` })));
  const door = listing("2004-2016 Audi A4 Front Left Door Shell OEM Used", undefined, "P3", "BLAP shipping policy 3kg");
  const est = { weight_kg: 22, length_cm: 130, width_cm: 90, height_cm: 40, basis: "door shell in a large box", confidence: "medium" as const };
  const a = analyzeShipping(door, est, pols, S);
  assert.equal(a.categoryKg, 94);
  assert.equal(a.overMax, true, "over the 70 kg policy");
  assert.equal(a.suggested?.id, "P70");
  assert.match(a.note, /largest policy \(70 kg\) - moving to the 70 kg policy/);

  const item = { ...door, itemId: "1", price: 100, currency: "USD", quantity: 1, quantitySold: 0, hasVariations: false, itemSpecifics: {}, variationNames: [], compatibilitySample: [] } as any;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.modules.description.enabled = false;
  assert.equal(settings.modules.shipping.apply, true, "switching is on by default");
  const { changes } = buildChanges(item, { title: door.title, recommended_price: 0, item_specifics: [] } as any, [], null, settings, [], [], a);
  assert.equal(changes.shippingPolicyId, "P70");

  // already on the largest policy -> nothing to change; a 70 kg policy also lifts the 60 kg max
  const on70 = analyzeShipping(listing(door.title, undefined, "P70", "BLAP shipping policy 70kg"), est, pols, S);
  assert.equal(on70.matches, true);
  const mid = analyzeShipping(listing(door.title, { weightKg: 65, lengthCm: 0, widthCm: 0, heightCm: 0 }, "P3", "x"), undefined, pols, S);
  assert.equal(mid.overMax, false);
  assert.equal(mid.suggested?.id, "P70");
});
