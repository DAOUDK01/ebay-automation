/** New vs used, genuine OEM vs aftermarket: title format, part number, specifics, A+ ribbon. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Aspect, EbayItem } from "../src/lib/ebay/types";
import { checkSpecifics, checkTitle } from "../src/lib/guardrails";
import { adaptTitleTemplate, classifyPart, looksLikePartNumber, partCondition, partLabel, primaryPartNumber } from "../src/lib/partKind";
import { DEFAULT_SETTINGS } from "../src/models/Store";
import { buildChanges } from "../src/services/pipeline";

const TEMPLATE = "{Year range} {Brand} {Model} {Part name and location} {Part number} OEM Used";
const FEBEST_TITLE = "FEBEST 2001-2006 Acura MDX Differential Mount Bushing HAB-133";
const febest = (extra: Partial<EbayItem> = {}) => ({
  title: FEBEST_TITLE,
  conditionId: "1000",
  condition: "New",
  itemSpecifics: { Brand: ["FEBEST"], "Manufacturer Part Number": ["HAB-133"] } as Record<string, string[]>,
  ...extra,
});
const HONDA_TITLE = "2016-2021 Honda Civic Front Left Headlight 33150-TBA-A01 OEM Used";
const honda = (extra: Partial<EbayItem> = {}) => ({
  title: HONDA_TITLE,
  conditionId: "3000",
  condition: "Used",
  itemSpecifics: { Brand: ["Honda"], "Manufacturer Part Number": ["33150-TBA-A01"] } as Record<string, string[]>,
  ...extra,
});

test("condition from eBay's condition id (name as fallback)", () => {
  assert.equal(partCondition("1000"), "new");
  assert.equal(partCondition("1500"), "new", "New other");
  assert.equal(partCondition("2500"), "reman");
  assert.equal(partCondition("3000"), "used");
  assert.equal(partCondition("7000"), "for_parts");
  assert.equal(partCondition("", "New"), "new");
  assert.equal(partCondition("", "Like New"), "used");
  assert.equal(partCondition(""), "used", "unknown = used (used-parts store)");
});

test("part numbers in titles", () => {
  for (const pn of ["HAB-133", "50728-S3V-A01", "33150TBAA01", "12345678", "(HAB-133)"]) assert.ok(looksLikePartNumber(pn), pn);
  for (const w of ["2001-2006", "2016-21", "6-Speed", "4-Cylinder", "AWD/4WD", "F-150", "RX350", "1500", "Bushing", "12Volt"]) {
    assert.ok(!looksLikePartNumber(w), w);
  }
  assert.equal(primaryPartNumber(FEBEST_TITLE, { "Manufacturer Part Number": ["HAB-133"] }), "HAB-133");
  assert.equal(primaryPartNumber("Acura MDX Mount 50728-S3V-A01 HAB-133", { "Manufacturer Part Number": ["HAB133"] }), "HAB-133", "MPN wins over the first number");
  assert.equal(primaryPartNumber("Acura MDX Mount 50728-S3V-A01 HAB-133"), "50728-S3V-A01");
  assert.equal(primaryPartNumber("2016-2021 Honda Civic Headlight"), "");
});

test("classify: FEBEST new = aftermarket; Honda used = genuine OEM; edge cases", () => {
  const f = classifyPart(febest());
  assert.deepEqual([f.condition, f.origin, f.brand, f.oemWording, f.partNumber], ["new", "aftermarket", "FEBEST", false, "HAB-133"]);
  assert.equal(partLabel(f), "New · Aftermarket (FEBEST)");

  // no Brand specific: brand spotted in the title
  const noBrand = classifyPart(febest({ itemSpecifics: {} }));
  assert.equal(noBrand.origin, "aftermarket");
  assert.equal(noBrand.brand, "FEBEST");

  const h = classifyPart(honda());
  assert.deepEqual([h.condition, h.origin, h.oemWording, h.partNumber], ["used", "oem", true, "33150-TBA-A01"]);
  assert.equal(partLabel(h), "Used · Genuine OEM");

  assert.equal(classifyPart(honda({ itemSpecifics: { Brand: ["Toyota Genuine"] } })).origin, "oem");
  assert.equal(classifyPart(honda({ itemSpecifics: { Brand: ["Motorcraft"] } })).origin, "oem");
  assert.equal(classifyPart(honda({ itemSpecifics: { Brand: ["Dorman"] } })).origin, "aftermarket");
  assert.equal(classifyPart(honda({ itemSpecifics: { Brand: ["Aftermarket"] } })).origin, "aftermarket");
  // a model name is not a brand: Honda *Pilot*, Ford *Crown* Victoria
  const pilot = classifyPart({ title: "2016-2020 Honda Pilot Front Left Headlight", conditionId: "3000", condition: "Used", itemSpecifics: {} });
  assert.equal(pilot.origin, "unknown");
  assert.equal(pilot.oemWording, true, "used + unknown keeps the store's usual OEM wording");
  // OE suppliers: used = pulled from a car, new = their own aftermarket part
  assert.equal(classifyPart(honda({ itemSpecifics: { Brand: ["Denso"] } })).oemWording, true);
  const newDenso = classifyPart(honda({ conditionId: "1000", itemSpecifics: { Brand: ["DENSO"] } }));
  assert.equal(newDenso.origin, "aftermarket");
  assert.equal(newDenso.oemWording, false);
  // unbranded: new = aftermarket, used = unknown
  assert.equal(classifyPart(honda({ conditionId: "1000", itemSpecifics: { Brand: ["Unbranded"] } })).origin, "aftermarket");
  assert.equal(classifyPart({ title: "Civic Headlight OEM", conditionId: "3000", condition: "Used", itemSpecifics: { Brand: ["Unbranded"] } }).origin, "oem");
  // new with no brand info at all: never claims OEM
  assert.equal(classifyPart({ title: "Civic Headlight Assembly", conditionId: "1000", condition: "New", itemSpecifics: {} }).oemWording, false);
});

test("title format adapts to the part: OEM Used / OEM New / New / Used / Remanufactured", () => {
  const k = (condition: any, oemWording: boolean) => ({ condition, oemWording });
  assert.equal(adaptTitleTemplate(TEMPLATE, k("used", true)), TEMPLATE);
  assert.equal(adaptTitleTemplate(TEMPLATE, k("new", true)), "{Year range} {Brand} {Model} {Part name and location} {Part number} OEM New");
  assert.equal(adaptTitleTemplate(TEMPLATE, k("new", false)), "{Year range} {Brand} {Model} {Part name and location} {Part number} New");
  assert.equal(adaptTitleTemplate(TEMPLATE, k("used", false)), "{Year range} {Brand} {Model} {Part name and location} {Part number} Used");
  assert.equal(adaptTitleTemplate(TEMPLATE, k("reman", false)), "{Year range} {Brand} {Model} {Part name and location} {Part number} Remanufactured");
  assert.equal(adaptTitleTemplate("Genuine {Brand} {Part} - Used OEM", k("new", false)), "{Brand} {Part} - New");
  assert.equal(adaptTitleTemplate("", k("new", false)), "");
});

test("checkTitle: the FEBEST case - no OEM Used, keeps HAB-133", () => {
  const kind = classifyPart(febest());
  // what Claude proposed before this fix
  const before = checkTitle(FEBEST_TITLE, "2001-2006 FEBEST Acura MDX Differential Mount Bushing 50728-S3V-A01 OEM Used", TEMPLATE, kind);
  assert.equal(before.value, null);
  assert.match(before.note, /OEM\/Genuine.*aftermarket part \(FEBEST\)/);

  const swapped = checkTitle(FEBEST_TITLE, "2001-2006 FEBEST Acura MDX Differential Mount Bushing 50728-S3V-A01 New", TEMPLATE, kind);
  assert.equal(swapped.value, null);
  assert.match(swapped.note, /part number HAB-133/);

  const used = checkTitle(FEBEST_TITLE, "2001-2006 FEBEST Acura MDX Differential Mount Bushing HAB-133 Used", TEMPLATE, kind);
  assert.match(used.note, /says Used.*New/);

  const noEnding = checkTitle(FEBEST_TITLE, "2001-2006 FEBEST Acura MDX Rear Differential Mount Bushing HAB-133", TEMPLATE, kind);
  assert.match(noEnding.note, /missing required text "New"/);

  const good = checkTitle(FEBEST_TITLE, "2001-2006 FEBEST Acura MDX Differential Mount Bushing HAB-133 New", TEMPLATE, kind);
  assert.equal(good.value, "2001-2006 FEBEST Acura MDX Differential Mount Bushing HAB-133 New");
});

test("checkTitle: used OEM unchanged rules + part number kept (dashes ignored) + no 'New'", () => {
  const kind = classifyPart(honda());
  const old = "Honda Civic 2016-2021 Headlight Left 33150-TBA-A01 OEM Used";
  assert.equal(checkTitle(old, "2016-2021 Honda Civic Front Left Headlight 33150TBAA01 OEM Used", TEMPLATE, kind).note, "title: ok");
  assert.match(checkTitle(old, "2016-2021 Honda Civic Front Left Headlight OEM Used", TEMPLATE, kind).note, /part number 33150-TBA-A01/);
  assert.match(checkTitle(old, "2016-2021 Honda Civic Front Left Headlight 33150-TBA-A01 OEM New", TEMPLATE, kind).note, /says New/);
  // without a kind (older callers) nothing changes
  assert.equal(checkTitle(old, "2016-2021 Honda Civic Front Left Headlight OEM Used", TEMPLATE).note, "title: ok");
});

test("checkSpecifics: an aftermarket part keeps its own Brand / MPN, never the car maker's", () => {
  const settings = { enabled: true, overwriteExisting: true, useOtherListings: true, allowKnowledge: true, allowCustomNames: true };
  const aspects: Aspect[] = ["Brand", "Manufacturer Part Number", "OE/OEM Part Number"].map((name) => ({
    name,
    required: false,
    usage: "RECOMMENDED",
    mode: "FREE_TEXT",
    multi: name === "OE/OEM Part Number",
    values: [],
  }));
  const suggested: any[] = [
    { name: "Brand", values: ["Acura"], source: "part_number_knowledge", confidence: "high" },
    { name: "Manufacturer Part Number", values: ["50728-S3V-A01"], source: "part_number_knowledge", confidence: "high" },
    { name: "OE/OEM Part Number", values: ["50728-S3V-A01"], source: "part_number_knowledge", confidence: "high" },
  ];
  const item = { ...febest(), variationNames: [] };
  const r = checkSpecifics(item, suggested, aspects, settings, [], classifyPart(item));
  assert.deepEqual(r.value?.Brand, ["FEBEST"]);
  assert.deepEqual(r.value?.["Manufacturer Part Number"], ["HAB-133"]);
  assert.deepEqual(r.value?.["OE/OEM Part Number"], ["50728-S3V-A01"], "the OE number it replaces is still useful here");
  assert.ok(r.notes.some((n) => /keep 'Brand'.*aftermarket/.test(n)));

  // no Brand yet: the car make is refused, the real brand is fine
  const bare = { ...febest({ itemSpecifics: {} }), variationNames: [] };
  const r2 = checkSpecifics(bare, suggested, aspects, settings, [], classifyPart(bare));
  assert.equal(r2.value?.Brand, undefined);
  assert.ok(r2.notes.some((n) => /skip 'Brand'.*not made by the car maker/.test(n)));
  const r3 = checkSpecifics(bare, [{ name: "Brand", values: ["FEBEST"], source: "listing_text", confidence: "high" }] as any, aspects, settings, [], classifyPart(bare));
  assert.deepEqual(r3.value?.Brand, ["FEBEST"]);

  // genuine OEM parts: unchanged (overwrite allowed as before)
  const oem = { ...honda({ itemSpecifics: { Brand: ["OEM"] } }), variationNames: [] };
  const r4 = checkSpecifics(oem, [{ name: "Brand", values: ["Honda"], source: "listing_text", confidence: "high" }] as any, aspects, settings, [], classifyPart(oem));
  assert.deepEqual(r4.value?.Brand, ["Honda"]);
});

test("pipeline: part shown in notes, title + A+ ribbon follow the part", () => {
  const content = {
    headline: "FEBEST Differential Mount Bushing for Acura MDX",
    intro: "A new FEBEST bushing.",
    highlights: ["Part number HAB-133"],
    fitment_summary: "Fits 2001-2006 Acura MDX.",
    condition_notes: "New and unused.",
    included: [],
    install_tips: "",
    faqs: [],
  };
  const item = {
    ...febest(),
    itemId: "920096145757", price: 25, currency: "USD", quantity: 1, quantitySold: 0, hasVariations: false,
    listingType: "FixedPriceItem", variationNames: [], compatibilitySample: [], compatibilityAll: [],
    pictures: ["https://i.ebayimg.com/a.jpg"], descriptionHtml: "",
  } as unknown as EbayItem;
  const s = structuredClone(DEFAULT_SETTINGS);
  s.modules.title = { enabled: true, template: TEMPLATE };
  const good = buildChanges(item, { title: "2001-2006 FEBEST Acura MDX Differential Mount Bushing HAB-133 New", recommended_price: 0, item_specifics: [], description_content: content } as any, [], null, s);
  assert.ok(good.notes[0].startsWith("part: New · Aftermarket (FEBEST) - Brand is FEBEST"));
  assert.equal(good.changes.title, "2001-2006 FEBEST Acura MDX Differential Mount Bushing HAB-133 New");
  assert.ok(good.changes.description?.includes(">Brand New</div>"));
  assert.ok(!good.changes.description?.includes(">Genuine OEM</div>"));

  const bad = buildChanges(item, { title: "2001-2006 FEBEST Acura MDX Differential Mount Bushing 50728-S3V-A01 OEM Used", recommended_price: 0, item_specifics: [] } as any, [], null, s);
  assert.equal(bad.changes.title, undefined);

  // a used genuine part still gets the Genuine OEM ribbon
  const usedItem = { ...item, ...honda() } as unknown as EbayItem;
  const used = buildChanges(usedItem, { title: HONDA_TITLE, recommended_price: 0, item_specifics: [], description_content: content } as any, [], null, s);
  assert.ok(used.changes.description?.includes(">Genuine OEM</div>"));
});
