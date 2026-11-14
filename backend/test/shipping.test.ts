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
