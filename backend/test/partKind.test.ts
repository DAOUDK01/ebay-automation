/** New vs used, genuine OEM vs aftermarket: title format, part number, specifics, A+ ribbon. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Aspect, EbayItem } from "../src/lib/ebay/types";
import { checkSpecifics, checkTitle } from "../src/lib/guardrails";
import { adaptTitleTemplate, classifyPart, descriptionConflict, looksLikePartNumber, partCondition, partLabel, primaryPartNumber } from "../src/lib/partKind";
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
  const usedContent = { ...content, headline: "Genuine Honda Civic Headlight", intro: "A used genuine Honda headlight.", condition_notes: "Used, light scratches." };
  const used = buildChanges(usedItem, { title: HONDA_TITLE, recommended_price: 0, item_specifics: [], description_content: usedContent } as any, [], null, s);
  assert.ok(used.changes.description?.includes(">Genuine OEM</div>"));
  // ...and "New and unused" text on that used part is refused
  const wrong = buildChanges(usedItem, { title: HONDA_TITLE, recommended_price: 0, item_specifics: [], description_content: content } as any, [], null, s);
  assert.equal(wrong.changes.description, undefined);
});

test("a wrong car-make Brand loses to an aftermarket maker in the title, and can be corrected", () => {
  const item = { ...febest({ itemSpecifics: { Brand: ["Acura"], "Manufacturer Part Number": ["HAB-133"] } }), variationNames: [] };
  const k = classifyPart(item);
  assert.deepEqual([k.origin, k.brand, k.brandSpecificWrong, k.oemWording], ["aftermarket", "FEBEST", true, false]);
  assert.match(k.reason, /title names FEBEST.*Brand specific says Acura/);
  const aspects: Aspect[] = [{ name: "Brand", required: true, usage: "RECOMMENDED", mode: "FREE_TEXT", multi: false, values: [] }];
  const noOverwrite = { enabled: true, overwriteExisting: false, useOtherListings: true, allowKnowledge: true, allowCustomNames: true };
  const r = checkSpecifics(item, [{ name: "Brand", values: ["FEBEST"], source: "listing_text", confidence: "high" }] as any, aspects, noOverwrite, [], k);
  assert.deepEqual(r.value?.Brand, ["FEBEST"], "corrected even with overwrite off");
  // multi-word brand keeps the title's spelling
  assert.equal(classifyPart({ title: "Beck Arnley 2010 Camry Wheel Bearing 051-6250", conditionId: "1000", condition: "New", itemSpecifics: {} }).brand, "Beck Arnley");
});

test("model / part names are not brands: seat belt Anchor, Kia Spectra", () => {
  const used = (title: string) => classifyPart({ title, conditionId: "3000", condition: "Used", itemSpecifics: {} });
  assert.equal(used("2016-2020 Honda Pilot Front Seat Belt Anchor Bolt OEM Used").origin, "oem");
  assert.equal(used("2004-2009 Kia Spectra Left Headlight").origin, "unknown");
  assert.equal(used("2004-2009 Kia Spectra Left Headlight").oemWording, true);
});

test("description text must match the condition and OEM status", () => {
  const newAfter = { condition: "new" as const, oemWording: false };
  const usedOem = { condition: "used" as const, oemWording: true };
  assert.equal(descriptionConflict("A used part pulled from a 2005 Acura MDX.", newAfter), "used part");
  assert.equal(descriptionConflict("It may show light wear.", newAfter), "light wear");
  assert.equal(descriptionConflict("Can be used with the original bolts. Brand new FEBEST bushing.", newAfter), "", "'used with' and 'brand new' are fine for a new part");
  assert.equal(descriptionConflict("Genuine Acura quality.", newAfter), "Genuine");
  assert.equal(descriptionConflict("Is it OEM? No - this is not a genuine Acura part, it is a FEBEST replacement. Replaces OEM number 50728-S3V-A01.", newAfter), "");
  assert.equal(descriptionConflict("Brand new in box!", usedOem), "Brand new");
  assert.equal(descriptionConflict("Never used.", usedOem), "Never used");
  assert.equal(descriptionConflict("Used genuine OEM part pulled from a 2018 Civic with normal signs of use.", usedOem), "");
});

test("pipeline: A+ text that calls a new part used is not applied", () => {
  const item = {
    ...febest(),
    itemId: "1", price: 25, currency: "USD", quantity: 1, quantitySold: 0, hasVariations: false, listingType: "FixedPriceItem",
    variationNames: [], compatibilitySample: [], compatibilityAll: [], pictures: [], descriptionHtml: "",
  } as unknown as EbayItem;
  const content = {
    headline: "FEBEST Bushing", intro: "Used part pulled from a running vehicle.", highlights: ["HAB-133"], fitment_summary: "Fits MDX.",
    condition_notes: "Normal signs of use.", included: [], install_tips: "", faqs: [],
  };
  const r = buildChanges(item, { title: FEBEST_TITLE, recommended_price: 0, item_specifics: [], description_content: content } as any, [], null, structuredClone(DEFAULT_SETTINGS));
  assert.equal(r.changes.description, undefined);
  assert.ok(r.notes.some((n) => /description rejected: says "Used part".*New · Aftermarket \(FEBEST\)/.test(n)), r.notes.join(" | "));
});

test("misspelled makes and unknown brands on used parts keep the store's OEM wording", () => {
  const used = (brand: string) => classifyPart({ title: "2008-2012 Infiniti EX35 Left Headlight", conditionId: "3000", condition: "Used", itemSpecifics: { Brand: [brand] } });
  for (const b of ["Bently", "Infinity Ex-35", "Volkswagon", "Porche", "Jaguar Xjl", "Jeep Grand"]) assert.equal(used(b).origin, "oem", b);
  const odd = used("Kazmi Parts Co");
  assert.equal(odd.origin, "unknown");
  assert.equal(odd.oemWording, true, "used + unknown brand: treated as the original part");
  assert.equal(used("Dorman").origin, "aftermarket", "a known aftermarket brand still counts on a used part");
  // a new part with an unknown brand is aftermarket (never "OEM")
  assert.equal(classifyPart({ title: "Kazmi Headlight", conditionId: "1000", condition: "New", itemSpecifics: { Brand: ["Kazmi Parts Co"] } }).oemWording, false);
});

test("aftermarket: the title must carry the brand's own number, even if an older title swapped it for the OE number", () => {
  const k = classifyPart(febest({ title: "2001-2006 FEBEST Acura MDX Differential Mount Bushing 50728-S3V-A01 OEM Used" }));
  assert.equal(k.partNumber, "HAB-133");
  const r = checkTitle(k ? "2001-2006 FEBEST Acura MDX Differential Mount Bushing 50728-S3V-A01 OEM Used" : "", "2001-2006 FEBEST Acura MDX Differential Mount Bushing HAB-133 New", TEMPLATE, k);
  assert.equal(r.note, "title: ok");
  assert.match(checkTitle("x", "2001-2006 FEBEST Acura MDX Differential Mount Bushing 50728-S3V-A01 New", TEMPLATE, k).note, /HAB-133/);
});
