import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeSuggestion } from "../src/lib/claude";
import type { CompatRow, EbayItem } from "../src/lib/ebay/types";
import { buildFitmentRows, extractPartNumbers, gatherFitmentEvidence, type FitmentDeps } from "../src/lib/fitment";
import { DEFAULT_SETTINGS, resolveSettings } from "../src/models/Store";

const item = (over: Partial<EbayItem> = {}): EbayItem => ({
  itemId: "920078281032", title: "01-04 Toyota Sequoia Front Left Door Shell OEM 67002-0C060 67002-0C061 Used",
  subtitle: "", sku: "", listingType: "FixedPriceItem", categoryId: "179850", categoryName: "Doors", conditionId: "3000",
  condition: "Used", price: 300, currency: "USD", quantity: 1, quantitySold: 0, watchCount: 0, hasVariations: false,
  variationNames: [], itemSpecifics: { Brand: ["Toyota"] }, compatibilityCount: 0, compatibilitySample: [],
  compatibilityAll: [], shipping: { options: [], dispatchDays: "1", policy: "", location: "" }, pictureCount: 5,
  imageUrl: "", descriptionText: "", url: "", site: "eBayMotors", ...over,
});

const S = resolveSettings(DEFAULT_SETTINGS);
const row = (Year: string, Model = "Sequoia", Trim = "Limited", Engine = "4.7L V8"): CompatRow => ({ Year, Make: "Toyota", Model, Trim, Engine });

test("part numbers: from title and specifics, not year ranges", () => {
  assert.deepEqual(extractPartNumbers(item()), ["67002-0C060", "67002-0C061"]);
  assert.deepEqual(
    extractPartNumbers(item({ title: "2001-2004 Toyota Sequoia Door", itemSpecifics: { "Manufacturer Part Number": ["90919-02240"] } })),
    ["90919-02240"],
  );
  assert.deepEqual(extractPartNumbers(item({ title: "Door 2001-2004", itemSpecifics: { MPN: ["Does Not Apply"] } })), []);
});

const refs: Record<string, CompatRow[]> = {
  A: [row("2001"), row("2002"), row("2003"), row("2004")],
  B: [row("2001"), row("2002"), row("2003"), row("2004"), row("2004", "Tundra", "SR5", "4.7L V8")],
  C: [], // listing without fitment - ignored
};
const deps: FitmentDeps = {
  searchByPartNumber: async (pn) => (pn === "67002-0C060" ? ["A", "B", "C", "920078281032"].map((id) => ({ itemId: id, title: `ref ${id}`, url: "" })) : []),
  getItemCompatibility: async (id) => ({
    itemId: id,
    title: `ref ${id}`,
    rows: refs[id] ?? [],
    specifics: {
      "Interchange Part Number": id === "C" ? ["67002-0C061"] : ["67002-0C061", "67002-0C060"],
      Placement: ["Front Left"],
      Color: ["Silver"], // per-copy: must be ignored
    },
  }),
  validateVehicle: async (_cat, v) => {
    if (v.Make.toLowerCase() === "toyota" && /^(sequoia|tundra)$/i.test(v.Model)) return { ...v, Make: "Toyota", Model: v.Model[0].toUpperCase() + v.Model.slice(1).toLowerCase() };
    if (v.Model === "Unknown") return undefined;
    return null;
  },
};

test("evidence: reads reference listings (fitment + specifics), skips own listing", async () => {
  const ev = await gatherFitmentEvidence(item(), deps, S);
  // C has no fitment but useful specifics -> still read; rowCount 0
  assert.deepEqual(ev.references.map((r) => `${r.itemId}:${r.rowCount}`), ["A:4", "B:5", "C:0"]);
  const inter = ev.specifics.find((s) => s.name === "Interchange Part Number")!;
  assert.equal(inter.listings, 3);
  assert.deepEqual(inter.values[0], { value: "67002-0C061", listings: 3 });
  assert.ok(!ev.specifics.some((s) => s.name === "Color"), "per-copy specifics are not learned from other listings");
  assert.equal(ev.rows.find((r) => r.row.Year === "2003" && r.row.Model === "Sequoia")!.support, 2);
  assert.equal(ev.summary[0].listings, 2);
  const off = await gatherFitmentEvidence(
    item(),
    deps,
    resolveSettings({ modules: { compatibility: { researchEbay: false }, specifics: { useOtherListings: false } } } as any),
  );
  assert.equal(off.references.length, 0, "no research when both fitment and specifics research are off");
  const specsOnly = await gatherFitmentEvidence(item(), deps, resolveSettings({ modules: { compatibility: { researchEbay: false } } } as any));
  assert.equal(specsOnly.rows.length, 0, "fitment off -> no vehicle rows");
  assert.ok(specsOnly.specifics.length > 0, "but specifics are still learned");
});

test("build: consensus rows + validated Claude rows, knowledge filtered, existing skipped", async () => {
  const ev = await gatherFitmentEvidence(item(), deps, S);
  const claude: ClaudeSuggestion["compatibility"] = [
    { year: "2005", make: "toyota", model: "sequoia", trim: "", engine: "", source: "part_number_knowledge", confidence: "high" },
    { year: "2006", make: "Toyota", model: "Sequoia", trim: "", engine: "", source: "part_number_knowledge", confidence: "medium" },
    { year: "2003", make: "Toyota", model: "Camry", trim: "", engine: "", source: "part_number_knowledge", confidence: "high" },
    { year: "2001", make: "Toyota", model: "Sequoia", trim: "", engine: "", source: "listing_text", confidence: "high" },
    { year: "2004", make: "Toyota", model: "Unknown", trim: "", engine: "", source: "part_number_knowledge", confidence: "high" },
  ];
  const existing = item({ compatibilityAll: [row("2002")] });
  const { rows, dropped } = await buildFitmentRows(existing, ev, claude, deps, S);
  const keys = rows.map((r) => `${r.Year} ${r.Model} ${r.Trim ?? "*"} ${r._source}`);

  // consensus: 2001, 2003, 2004 Sequoia (2002 already on the listing); Tundra only in 1 listing -> not used
  assert.ok(keys.includes("2001 Sequoia Limited ebay_listings"));
  assert.ok(keys.includes("2003 Sequoia Limited ebay_listings"));
  assert.ok(!keys.some((k) => k.startsWith("2002 Sequoia")), "existing vehicle not added again");
  assert.ok(!keys.some((k) => k.includes("Tundra")), "single-listing vehicle needs consensus");
  // high-confidence knowledge, validated + normalised to eBay spelling
  assert.ok(keys.includes("2005 Sequoia * part_number_knowledge"));
  assert.equal(rows.find((r) => r.Year === "2005")!.Make, "Toyota");
  // listing_text 2001 Sequoia duplicates the specific consensus rows -> not added as a broad row
  assert.equal(rows.filter((r) => r.Year === "2001").length, 1);
  assert.ok(dropped.some((d) => d.startsWith("2006 Toyota Sequoia") && d.includes("medium")));
  assert.ok(dropped.some((d) => d.startsWith("2003 Toyota Camry") && d.includes("catalog")));
  assert.ok(dropped.some((d) => d.startsWith("2004 Toyota Unknown") && d.includes("couldn't verify")));

  // knowledge disabled -> only consensus rows
  const noKnow = resolveSettings({ modules: { compatibility: { allowKnowledge: false } } } as any);
  const r2 = await buildFitmentRows(existing, ev, claude, deps, noKnow);
  assert.ok(r2.rows.every((r) => r._source !== "part_number_knowledge"));

  // minListings 1 -> Tundra included too
  const loose = resolveSettings({ modules: { compatibility: { minListings: 1 } } } as any);
  const r3 = await buildFitmentRows(existing, ev, [], deps, loose);
  assert.ok(r3.rows.some((r) => r.Model === "Tundra"));
});
