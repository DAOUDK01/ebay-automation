import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCompatibility,
  checkPrice,
  checkSpecifics,
  checkTitle,
  inActiveHours,
  priceFloor,
  templateLiterals,
} from "../src/lib/guardrails";
import { buildReviseXml, normalizeItem } from "../src/lib/ebay/trading";
import { DEFAULT_SETTINGS, resolveSettings } from "../src/models/Store";
import { XMLParser } from "fast-xml-parser";
import type { Aspect } from "../src/lib/ebay/types";

const pricing = DEFAULT_SETTINGS.modules.pricing;
const ASPECTS: Aspect[] = [
  { name: "Brand", required: true, usage: "RECOMMENDED", mode: "FREE_TEXT", multi: false, maxLength: 65, values: [] },
  { name: "Manufacturer Part Number", required: false, usage: "RECOMMENDED", mode: "FREE_TEXT", multi: false, maxLength: 65, values: [] },
  { name: "Friction Material", required: false, usage: "RECOMMENDED", mode: "SELECTION_ONLY", multi: false, values: ["Ceramic", "Semi-Metallic"] },
  { name: "Placement on Vehicle", required: false, usage: "RECOMMENDED", mode: "SELECTION_ONLY", multi: true, values: ["Front", "Rear"] },
];

test("title: rejects >80 chars, spam, and big shortening", () => {
  assert.equal(checkTitle("abc", "x".repeat(81)).value, null);
  assert.equal(checkTitle("Old title here", "L@@K Old title here!!").value, null);
  assert.equal(checkTitle("A fairly long existing listing title with details", "Short").value, null);
  assert.equal(checkTitle("Same", " Same ").value, null);
  assert.equal(checkTitle("Brake pads", "Acme Front Ceramic Brake Pads").value, "Acme Front Ceramic Brake Pads");
});

test("title format: fixed text outside {…} is required", () => {
  const tpl = "{Year range} {Brand} {Model} {Part name and location} {Part number} Used OEM";
  assert.deepEqual(templateLiterals(tpl), ["Used OEM"]);
  assert.deepEqual(templateLiterals(""), []);
  assert.deepEqual(templateLiterals("Genuine {Brand} {Part} - Free Returns"), ["Genuine", "- Free Returns"]);
  const old = "Honda Civic front left headlight assembly 33150-TBA-A01 used";
  const ok = checkTitle(old, "2016-2018 Honda Civic Headlight Front Left 33150-TBA-A01 Used OEM", tpl);
  assert.equal(ok.value, "2016-2018 Honda Civic Headlight Front Left 33150-TBA-A01 Used OEM");
  const missing = checkTitle(old, "2016-2018 Honda Civic Headlight Front Left 33150-TBA-A01 OEM Part", tpl);
  assert.equal(missing.value, null);
  assert.match(missing.note, /missing required text "Used OEM"/);
  // case-insensitive match is accepted
  assert.ok(checkTitle(old, "2016-2018 Honda Civic Headlight Front Left 33150-TBA-A01 used oem", tpl).value);
  // no template -> no requirement
  assert.ok(checkTitle(old, "2016-2018 Honda Civic Headlight Front Left 33150-TBA-A01 OEM Part").value);
});

test("price: capped, needs cost to decrease, respects floor", () => {
  const item = { price: 40, hasVariations: false };
  assert.equal(checkPrice(item, 30, null, pricing).value, null); // no cost -> no decrease
  assert.equal(checkPrice(item, 50, null, pricing).value, 42); // capped at +5%
  assert.equal(priceFloor(30, pricing), 39.88);
  assert.equal(checkPrice(item, 30, 30, pricing).value, 39.88); // floored
  assert.equal(checkPrice(item, 40.2, 10, pricing).value, null); // <1%
  assert.equal(checkPrice({ price: 40, hasVariations: true }, 50, null, pricing).value, null);
  assert.equal(checkPrice(item, 38, 10, { ...pricing, enabled: false }).value, null);
});

test("specifics: only valid aspects, allowed values, no overwrite by default", () => {
  const item = { itemSpecifics: { Brand: ["Acme"] }, variationNames: [] };
  const r = checkSpecifics(
    item,
    [
      { name: "Manufacturer Part Number", values: ["AC-555"], source: "listing_text" as const, confidence: "high" as const },
      { name: "friction material", values: ["ceramic"], source: "listing_text" as const, confidence: "high" as const },
      { name: "Placement on Vehicle", values: ["Front", "Middle"], source: "listing_text" as const, confidence: "high" as const },
      { name: "Made Up", values: ["x"], source: "listing_text" as const, confidence: "high" as const },
      { name: "Brand", values: ["Other"], source: "listing_text" as const, confidence: "high" as const },
    ],
    ASPECTS,
    DEFAULT_SETTINGS.modules.specifics,
  );
  assert.deepEqual(r.value, { Brand: ["Acme"], "Manufacturer Part Number": ["AC-555"], "Friction Material": ["Ceramic"] });
  const multi = checkSpecifics(item, [{ name: "Placement on Vehicle", values: ["Front", "Rear"], source: "listing_text" as const, confidence: "high" as const }], ASPECTS, DEFAULT_SETTINGS.modules.specifics);
  assert.deepEqual(multi.value?.["Placement on Vehicle"], ["Front", "Rear"]);
  const ow = checkSpecifics(item, [{ name: "Brand", values: ["Bosch"], source: "listing_text" as const, confidence: "high" as const }], ASPECTS, { ...DEFAULT_SETTINGS.modules.specifics, overwriteExisting: true });
  assert.deepEqual(ow.value?.Brand, ["Bosch"]);
});

test("specifics: other listings, part-number knowledge, custom part-number names, per-copy protection", () => {
  const item = { itemSpecifics: { Brand: ["Audi"] }, variationNames: [] };
  const S = DEFAULT_SETTINGS.modules.specifics;
  const sug = [
    { name: "Interchange Part Number", values: ["8J0857501", "8J0857501A"], source: "part_number_knowledge" as const, confidence: "high" as const },
    { name: "Superseded Part Number", values: ["8J0857501B"], source: "part_number_knowledge" as const, confidence: "medium" as const },
    { name: "Mirror Features", values: ["Heated", "Power Folding"], source: "other_listings" as const, confidence: "high" as const },
    { name: "Color", values: ["Black"], source: "other_listings" as const, confidence: "high" as const },
    { name: "Random Thing", values: ["x"], source: "other_listings" as const, confidence: "high" as const },
    { name: "Friction Material", values: ["Ceramic"], source: "listing_text" as const, confidence: "high" as const },
  ];
  const r = checkSpecifics(item, sug, ASPECTS, S, ["Mirror Features"]);
  assert.deepEqual(r.value?.["Interchange Part Number"], ["8J0857501", "8J0857501A"], "custom part-number specific allowed");
  assert.equal(r.value?.["Superseded Part Number"], undefined, "medium-confidence knowledge skipped");
  assert.deepEqual(r.value?.["Mirror Features"], ["Heated", "Power Folding"], "name used by other same-part listings allowed");
  assert.equal(r.value?.Color, undefined, "color never taken from other listings");
  assert.equal(r.value?.["Random Thing"], undefined, "unknown custom name rejected");
  assert.deepEqual(r.value?.["Friction Material"], ["Ceramic"]);
  assert.ok(r.notes.some((n) => /add 'Interchange Part Number'.*part-number knowledge/.test(n)));

  // switches off
  const strict = checkSpecifics(item, sug, ASPECTS, { ...S, allowKnowledge: false, useOtherListings: false, allowCustomNames: false }, ["Mirror Features"]);
  assert.deepEqual(Object.keys(strict.value ?? {}).sort(), ["Brand", "Friction Material"]);

  // 45 cap: category aspects win over custom names
  const full = { itemSpecifics: Object.fromEntries(Array.from({ length: 44 }, (_, i) => [`Spec ${i}`, ["x"]])), variationNames: [] };
  const capped = checkSpecifics(
    full,
    [
      { name: "Interchange Part Number", values: ["1"], source: "listing_text", confidence: "high" },
      { name: "Friction Material", values: ["Ceramic"], source: "listing_text", confidence: "high" },
    ],
    ASPECTS,
    S,
  );
  assert.deepEqual(capped.value?.["Friction Material"], ["Ceramic"]);
  assert.equal(capped.value?.["Interchange Part Number"], undefined);
  assert.equal(Object.keys(capped.value!).length, 45);
});

test("compatibility: report-only by default; push strips internal fields", () => {
  const rows = [
    { Year: "2017", Make: "Honda", Model: "Civic", Trim: "EX", Engine: "2.0L", _source: "ebay_listings" as const, _support: "3" },
    { Year: "2018", Make: "Honda", Model: "Civic", _source: "part_number_knowledge" as const, _support: "" },
  ];
  const r = checkCompatibility(rows, DEFAULT_SETTINGS.modules.compatibility);
  assert.equal(r.value, null);
  assert.equal(r.suggested.length, 2);
  assert.match(r.note, /1 from other eBay listings, 1 from part-number knowledge\) - report only/);
  const applied = checkCompatibility(rows, { ...DEFAULT_SETTINGS.modules.compatibility, apply: true });
  assert.deepEqual(applied.value, [
    { Year: "2017", Make: "Honda", Model: "Civic", Trim: "EX", Engine: "2.0L" },
    { Year: "2018", Make: "Honda", Model: "Civic" },
  ]);
  assert.equal(checkCompatibility(rows, { ...DEFAULT_SETTINGS.modules.compatibility, enabled: false }).suggested.length, 0);
});

test("active hours incl. windows crossing midnight", () => {
  const noon = new Date("2026-06-01T12:00:00Z");
  assert.equal(inActiveHours({ enabled: true, start: "08:00", end: "23:00", timezone: "UTC" }, noon), true);
  assert.equal(inActiveHours({ enabled: true, start: "22:00", end: "06:00", timezone: "UTC" }, noon), false);
  assert.equal(inActiveHours({ enabled: true, start: "22:00", end: "06:00", timezone: "UTC" }, new Date("2026-06-01T23:30:00Z")), true);
  assert.equal(inActiveHours({ enabled: false, start: "22:00", end: "06:00", timezone: "UTC" }, noon), true);
});

test("settings merge keeps new defaults", () => {
  const s = resolveSettings({ mode: "auto", modules: { pricing: { maxChangePct: 3 } } } as any);
  assert.equal(s.mode, "auto");
  assert.equal(s.modules.pricing.maxChangePct, 3);
  assert.equal(s.modules.pricing.feePct, 13.5);
  assert.equal(s.claude.model, "claude-opus-5-5");
});

test("Trading XML: parse GetItem and build ReviseFixedPriceItem", () => {
  const xml = `<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>
  <Item><ItemID>111</ItemID><Title>T &amp; Co</Title><ListingType>FixedPriceItem</ListingType>
  <PrimaryCategory><CategoryID>33572</CategoryID><CategoryName>Brake Pads</CategoryName></PrimaryCategory>
  <StartPrice currencyID="USD">40.0</StartPrice><Quantity>5</Quantity><SellingStatus><QuantitySold>2</QuantitySold></SellingStatus>
  <ItemSpecifics><NameValueList><Name>Brand</Name><Value>Acme</Value></NameValueList>
  <NameValueList><Name>Placement</Name><Value>Front</Value><Value>Rear</Value></NameValueList></ItemSpecifics>
  <ItemCompatibilityList><Compatibility><NameValueList/><NameValueList><Name>Year</Name><Value>2016</Value></NameValueList>
  <NameValueList><Name>Make</Name><Value>Honda</Value></NameValueList></Compatibility></ItemCompatibilityList>
  <PictureDetails><PictureURL>https://i.ebayimg.com/a.jpg</PictureURL></PictureDetails>
  <Description>&lt;p&gt;Fits Civic&lt;/p&gt;</Description></Item></GetItemResponse>`;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (n) => ["Item", "NameValueList", "Value", "Compatibility", "Errors", "PictureURL"].includes(n),
  });
  const it = normalizeItem("111", parser.parse(xml).GetItemResponse.Item[0]);
  assert.equal(it.title, "T & Co");
  assert.equal(it.price, 40);
  assert.equal(it.quantitySold, 2);
  assert.deepEqual(it.itemSpecifics, { Brand: ["Acme"], Placement: ["Front", "Rear"] });
  assert.deepEqual(it.compatibilitySample, [{ Year: "2016", Make: "Honda" }]);
  assert.equal(it.descriptionText, "Fits Civic");
  assert.equal(it.imageUrl, "https://i.ebayimg.com/a.jpg");

  const out = buildReviseXml("111", { title: "A & B", price: 39.9, itemSpecifics: { Brand: ["Acme"] }, compatibilityAdd: [{ Year: "2017", Make: "Honda" }] });
  assert.match(out, /<Title>A &amp; B<\/Title>/);
  assert.match(out, /<StartPrice>39.90<\/StartPrice>/);
  assert.match(out, /<ItemSpecifics><NameValueList><Name>Brand<\/Name><Value>Acme<\/Value><\/NameValueList><\/ItemSpecifics>/);
  assert.match(out, /<ReplaceAll>false<\/ReplaceAll><Compatibility>/);
});
