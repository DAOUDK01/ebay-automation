import assert from "node:assert/strict";
import { test } from "node:test";
import type { DescriptionContent } from "../src/lib/claude";
import {
  APLUS_MARKER,
  cleanText,
  descriptionToText,
  groupFitment,
  hasContent,
  originalNotes,
  renderAplus,
  wordmark,
  yearRuns,
} from "../src/lib/description";
import type { EbayItem } from "../src/lib/ebay/types";
import { DEFAULT_SETTINGS, resolveSettings } from "../src/models/Store";
import { buildChanges } from "../src/services/pipeline";

const brand = DEFAULT_SETTINGS.modules.description;
const content: DescriptionContent = {
  headline: "Genuine Honda Civic Front Left Headlight",
  intro: "Used genuine Honda headlight.",
  highlights: ["Genuine OEM part", "Part 33150-TBA-A01"],
  fitment_summary: "Fits 2016-2021 Civic.",
  condition_notes: "Light scratches.",
  included: ["Headlight only"],
  install_tips: "",
};
const base = {
  content,
  title: "2016-2021 Honda Civic Headlight",
  condition: "Used",
  pictures: ["https://i.ebayimg.com/a.jpg", "http://insecure.example/b.jpg", "https://i.ebayimg.com/c.jpg"],
  specifics: { "Manufacturer Part Number": ["33150-TBA-A01"], Brand: ["Honda"], Color: ["Clear"] },
  compatibility: [2016, 2017, 2018, 2020].map((y) => ({ Year: String(y), Make: "Honda", Model: "Civic" })),
  brand,
  storeName: "partsco",
};

test("description html -> plain text", () => {
  const t = descriptionToText(`<style>p{}</style><p>Pulled from a <b>2018</b> Civic&nbsp;&amp; tested.</p><ul><li>Bulbs not included</li></ul><br>62k&#39;s`);
  assert.equal(t, "Pulled from a 2018 Civic & tested.\n- Bulbs not included\n\n62k's");
});

test("helpers: year runs, fitment grouping, link/email stripping, content check", () => {
  assert.equal(yearRuns([2018, 2016, 2017, 2020, 2020]), "2016-2018, 2020");
  assert.deepEqual(groupFitment([...base.compatibility, { Year: "2019", Make: "Acura", Model: "ILX" }]), [
    { vehicle: "Honda Civic", years: "2016-2018, 2020", count: 4 },
    { vehicle: "Acura ILX", years: "2019", count: 1 },
  ]);
  assert.equal(cleanText("Call us at parts@shop.com or visit https://shop.com today"), "Call us at or visit today");
  assert.equal(hasContent(content), true);
  assert.equal(hasContent({ ...content, headline: " " }), false);
  assert.equal(hasContent(undefined), false);
});

test("render: branded, escaped, https photos only, specs ordered, notes kept", () => {
  const html = renderAplus({
    ...base,
    brand: { ...brand, brandName: "" },
    content: { ...content, highlights: ['<script>alert(1)</script> fits "all"', "see www.other.com"] },
    currentHtml: "<p>Pulled from a 2018 Civic, 62k miles.</p>",
  });
  assert.ok(html.startsWith(APLUS_MARKER));
  assert.ok(!html.includes("<script"), "Claude text is escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; fits &quot;all&quot;"));
  assert.ok(!html.includes("www.other.com"));
  assert.ok(html.includes("https://i.ebayimg.com/a.jpg") && html.includes("https://i.ebayimg.com/c.jpg"));
  assert.ok(!html.includes("insecure.example"), "non-https photos dropped");
  assert.ok(html.indexOf(">Brand<") < html.indexOf(">Manufacturer Part Number<"), "Brand row first");
  assert.ok(html.includes("2016-2018, 2020"));
  assert.ok(html.includes("partsco"), "falls back to the store name");
  assert.ok(html.includes("Pulled from a 2018 Civic, 62k miles."));
  assert.ok(!html.includes("Warranty"), "empty warranty box hidden");
});

test("re-optimizing an A+ description keeps the original notes, never nests", () => {
  const first = renderAplus({ ...base, currentHtml: "<p>Original <i>seller</i> note &amp; more</p>" });
  assert.equal(originalNotes(first), "Original seller note & more");
  const second = renderAplus({ ...base, content: { ...content, headline: "Updated" }, currentHtml: first });
  assert.equal(second.split(APLUS_MARKER).length, 2, "one marker only");
  assert.equal(originalNotes(second), "Original seller note & more");
  assert.equal(second.split("Seller notes").length, 2);
});

test("settings: brand name, logo (https only), colour, toggles", () => {
  const html = renderAplus({
    ...base,
    brand: { ...brand, brandName: "Kazmi Auto", logoUrl: "javascript:alert(1)", accentColor: "red;x", showPhotos: false, showCompatibility: false, keepOriginalNotes: false, warrantyText: "30 day warranty" },
    currentHtml: "<p>old notes</p>",
  });
  assert.ok(html.includes("Kazmi Auto"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("#e11d2a") && !html.includes("red;x"), "bad colour falls back");
  assert.ok(!html.includes("i.ebayimg.com"));
  assert.ok(!html.includes("2016-2018, 2020"));
  assert.ok(!html.includes("old notes"));
  assert.ok(html.includes("30 day warranty"));
});

test("pipeline: description change built from final specifics + added fitment", () => {
  const item = {
    itemId: "1", title: "2016-2021 Honda Civic Headlight", price: 100, currency: "USD", quantity: 1, quantitySold: 0,
    hasVariations: false, listingType: "FixedPriceItem", condition: "Used", itemSpecifics: { Brand: ["Honda"] }, variationNames: [],
    compatibilitySample: [], compatibilityAll: [{ Year: "2016", Make: "Honda", Model: "Civic" }],
    pictures: ["https://i.ebayimg.com/a.jpg"], descriptionHtml: "<p>old</p>",
  } as unknown as EbayItem;
  const suggestion: any = { title: item.title, recommended_price: 0, item_specifics: [], description_content: content };
  const s = structuredClone(DEFAULT_SETTINGS);
  const { changes, notes } = buildChanges(item, suggestion, [], null, s, [], [], null, "partsco");
  assert.ok(changes.description?.includes("Genuine Honda Civic Front Left Headlight"));
  assert.ok(notes.includes("description: new branded A+ content"));
  s.modules.description.enabled = false;
  assert.equal(buildChanges(item, suggestion, [], null, s).changes.description, undefined);
  s.modules.description.enabled = true;
  const empty = buildChanges(item, { ...suggestion, description_content: undefined }, [], null, s);
  assert.equal(empty.changes.description, undefined);
  assert.ok(empty.notes.some((n) => /no content/.test(n)));
});

test("store branding: wordmark highlight, badges, footer, old blue defaults migrate", () => {
  assert.equal(
    wordmark("MotorSupply Co", "supply", "#e11d2a").replace(/ style="[^"]*"/g, ""),
    "<span>Motor<span>Supply</span> Co</span>",
  );
  const html = renderAplus(base);
  assert.ok(html.includes(">Supply</span>"));
  for (const t of ["Quality parts", "Fast shipping", "Wide selection", "Global delivery", "Thank you for your business.", "#0b0f19"]) assert.ok(html.includes(t), t);
  // a store saved with the first (generic blue) defaults gets the store look; customised ones are kept
  const old = { modules: { description: { ...brand, brandName: "", accentColor: "#1e3a8a", badges: undefined } } } as any;
  const d = resolveSettings(old).modules.description;
  assert.equal(d.brandName, "MotorSupply Co");
  assert.equal(d.accentColor, "#e11d2a");
  assert.equal(d.badges.length, 4);
  const custom = resolveSettings({ modules: { description: { ...brand, brandName: "My Shop", accentColor: "#1e3a8a" } } } as any).modules.description;
  assert.equal(custom.brandName, "My Shop");
  assert.equal(custom.accentColor, "#1e3a8a");
});
