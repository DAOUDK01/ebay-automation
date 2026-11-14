import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviseXml } from "../src/lib/ebay/trading";
import type { EbayItem } from "../src/lib/ebay/types";
import { computeManualChanges } from "../src/services/listingEdit";

const before: EbayItem = {
  itemId: "920080142571", title: "01-07 Toyota Sequoia Front Right Side Mirror Assembly OEM Black 87910-0C130-C0 O",
  subtitle: "", sku: "TOYO-5243-SM-1", listingType: "FixedPriceItem", categoryId: "33649", categoryName: "Mirrors",
  conditionId: "3000", condition: "Used", price: 150, currency: "USD", quantity: 3, quantitySold: 1, watchCount: 0,
  hasVariations: false, variationNames: [], itemSpecifics: { Brand: ["Toyota"], Placement: ["Right"] },
  compatibilityCount: 2, compatibilitySample: [],
  compatibilityAll: [
    { Year: "2001", Make: "Toyota", Model: "Sequoia" },
    { Year: "2002", Make: "Toyota", Model: "Sequoia" },
  ],
  shipping: { options: [], dispatchDays: "1", policy: "", location: "" }, pictureCount: 1, imageUrl: "",
  descriptionText: "", descriptionHtml: "<p>Good mirror</p>", url: "", site: "eBayMotors",
};

test("manual edit: only changed fields are sent", () => {
  assert.deepEqual(
    computeManualChanges(before, {
      title: before.title,
      price: 150,
      quantityAvailable: 2, // 2 available + 1 sold = 3 total = unchanged
      description: "<p>Good mirror</p>",
      itemSpecifics: { placement: ["Right"], Brand: ["Toyota", " "] },
      compatibility: [...before.compatibilityAll!].reverse(),
    }),
    {},
  );
  const c = computeManualChanges(before, {
    title: "  2001-2007 Toyota   Sequoia Right Mirror 87910-0C130-C0 Used OEM ",
    price: 139.999,
    quantityAvailable: 5,
    description: "<p>Great mirror</p>",
    itemSpecifics: { Brand: ["Toyota"], Placement: ["Right"], "Interchange Part Number": ["87910-0C130"] },
    compatibility: [...before.compatibilityAll!, { Year: "2003", Make: "Toyota", Model: "Sequoia", Trim: " " }, { Year: "", Make: "x", Model: "y" }],
  });
  assert.equal(c.title, "2001-2007 Toyota Sequoia Right Mirror 87910-0C130-C0 Used OEM");
  assert.equal(c.price, 140);
  assert.equal(c.quantity, 6, "eBay Quantity = available (5) + sold (1)");
  assert.equal(c.description, "<p>Great mirror</p>");
  assert.deepEqual(c.itemSpecifics?.["Interchange Part Number"], ["87910-0C130"]);
  assert.deepEqual(c.compatibilityReplace?.[2], { Year: "2003", Make: "Toyota", Model: "Sequoia" }, "blank trim dropped, invalid row removed");
  assert.equal(c.compatibilityReplace?.length, 3);
});

test("manual edit: validation", () => {
  assert.throws(() => computeManualChanges(before, { title: "x".repeat(81) }), /80/);
  assert.throws(() => computeManualChanges(before, { title: "   " }), /empty/);
  assert.throws(() => computeManualChanges(before, { price: 0 }), /greater than 0/);
  assert.throws(() => computeManualChanges({ ...before, hasVariations: true }, { price: 10 }), /variations/);
  assert.throws(
    () => computeManualChanges(before, { itemSpecifics: Object.fromEntries(Array.from({ length: 46 }, (_, i) => [`S${i}`, ["v"]])) }),
    /45/,
  );
  assert.throws(() => computeManualChanges(before, { itemSpecifics: { Brand: ["x".repeat(66)] } }), /65/);
});

test("revise XML: quantity, description CDATA, full compatibility replace / delete", () => {
  const xml = buildReviseXml("1", {
    quantity: 6,
    description: "<p>a]]>b</p>",
    compatibilityReplace: [{ Year: "2003", Make: "Toyota", Model: "Sequoia" }],
  });
  assert.match(xml, /<Quantity>6<\/Quantity>/);
  assert.match(xml, /<Description><!\[CDATA\[<p>a]]]]><!\[CDATA\[>b<\/p>]]><\/Description>/);
  assert.match(xml, /<ReplaceAll>true<\/ReplaceAll><Compatibility>.*<Value>Sequoia<\/Value>/);
  const clear = buildReviseXml("1", { compatibilityReplace: [] });
  assert.match(clear, /<\/Item><DeleteField>Item\.ItemCompatibilityList<\/DeleteField>$/);
  assert.doesNotMatch(clear, /ItemCompatibilityList><ReplaceAll/);
});
