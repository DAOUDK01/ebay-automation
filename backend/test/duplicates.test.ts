/** Duplicate listings finder: grouping by SKU / title / part number, keep choice, ignore, safe bulk end. */
process.env.JWT_SECRET = "test-secret";
process.env.ENCRYPTION_KEY = "test-key";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { encrypt } from "../src/lib/crypto";
import { AUTH_COOKIE, requireAuth, signSession } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/error";
import { Listing } from "../src/models/Listing";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import { findDuplicates, groupKey, wouldEndWholeGroup } from "../src/modules/inventory/duplicates";
import { InventoryItem } from "../src/modules/inventory/model";
import { inventoryRouter } from "../src/modules/inventory/routes";
import { fakeTrading } from "./fakeTrading";

let mongo: MongoMemoryServer;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const L = (itemId: string, title: string, o: any = {}) => ({ itemId, title, ...o });

test("grouping: same SKU, identical title, shared part number - chained into one group; keep the best seller", () => {
  const groups = findDuplicates([
    L("100000001", "2016-2021 Honda Civic Front Left Headlight 33150-TBA-A01 OEM Used", { sku: "HL-1", quantitySold: 0 }),
    L("100000002", "2016-2021 Honda Civic Front Left Headlight 33150-TBA-A01 OEM Used", { quantitySold: 3 }),
    L("100000003", "Civic headlamp driver side 33150TBAA01", { watchCount: 5 }),
    L("100000004", "Toyota Camry Rear Brake Rotors Pair", { sku: "ROT-9" }),
    L("100000005", "Camry rotors rear set", { sku: "rot-9 " }),
    L("100000006", "Ford F150 Mirror Right 5.0L", {}),
  ]);
  assert.equal(groups.length, 2);
  const hl = groups.find((g) => g.listings.length === 3)!;
  assert.deepEqual(hl.reasons.sort(), ["part_number", "title"]);
  assert.equal(hl.confidence, "high");
  assert.equal(hl.keepItemId, "100000002", "most sold is kept");
  assert.ok(hl.matches.some((m) => m.includes("33150TBAA01")));
  const rot = groups.find((g) => g.reasons.includes("sku"))!;
  assert.deepEqual(rot.listings.map((l) => l.itemId).sort(), ["100000004", "100000005"]);
  assert.ok(rot.matches.includes("SKU ROT-9"));

  // part number only -> medium confidence
  const pnOnly = findDuplicates([L("200000001", "Audi A4 Door Lock 8K0837015", {}), L("200000002", "A4 lock actuator front left 8K0837015", {})]);
  assert.equal(pnOnly[0].confidence, "medium");

  // ignored groups are hidden; never end a whole group
  const key = groupKey(["200000001", "200000002"]);
  assert.equal(findDuplicates([L("200000001", "Audi A4 Door Lock 8K0837015"), L("200000002", "lock 8K0837015")], new Set([key])).length, 0);
  assert.deepEqual(wouldEndWholeGroup(pnOnly, ["200000001"]), []);
  assert.deepEqual(wouldEndWholeGroup(pnOnly, ["200000001", "200000002"]), [pnOnly[0].key]);
  // titles alone that just look alike aren't grouped
  assert.equal(findDuplicates([L("300000001", "Honda Civic Headlight Left"), L("300000002", "Honda Civic Headlight Right")]).length, 0);
});

test("API: list groups, ignore, end selected duplicates on eBay (confirm + keep-one guard)", async () => {
  const userId = new mongoose.Types.ObjectId();
  const store = (await Store.create({
    userId,
    ebayUserId: "seller_d",
    name: "Dup Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: [] },
    settings: structuredClone(DEFAULT_SETTINGS),
  })) as StoreDocument;
  await Listing.create([
    { storeId: store._id, itemId: "400000001", title: "BMW X5 Tail Light Left 63217290103 OEM", active: true, quantitySold: 2 },
    { storeId: store._id, itemId: "400000002", title: "BMW X5 Tail Light Left 63217290103 OEM", active: true },
    { storeId: store._id, itemId: "400000003", title: "BMW X5 taillamp LH 63217290103", active: true },
    { storeId: store._id, itemId: "400000009", title: "Unrelated part", active: true },
  ]);
  await InventoryItem.create({ storeId: store._id, itemId: "400000002", title: "BMW X5 Tail Light Left 63217290103 OEM", status: "active", listingType: "FixedPriceItem" });
  const ended: string[] = [];
  const t = fakeTrading({
    EndFixedPriceItem: (xml) => {
      ended.push(/<ItemID>(\d+)<\/ItemID>/.exec(xml)![1]);
      return `<EndTime>2026-11-20T12:00:00.000Z</EndTime>`;
    },
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/stores/:storeId/inventory", requireAuth, inventoryRouter(() => t));
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stores/${store._id}/inventory`;
  const headers = { cookie: `${AUTH_COOKIE}=${signSession(String(userId))}`, "Content-Type": "application/json" };
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const list = await (await fetch(`${base}/duplicates`, { headers })).json();
    assert.equal(list.totals.groups, 1);
    assert.equal(list.totals.extraListings, 2);
    assert.equal(list.groups[0].keepItemId, "400000001");

    assert.equal((await post("/duplicates/end", { itemIds: ["400000002"] })).status, 400, "needs confirm");
    assert.equal((await post("/duplicates/end", { itemIds: ["400000001", "400000002", "400000003"], confirm: true })).status, 400, "would end every copy");
    assert.equal((await post("/duplicates/end", { itemIds: ["400000009"], confirm: true })).status, 400, "not a duplicate");
    assert.equal(ended.length, 0, "nothing sent to eBay so far");

    const r = await (await post("/duplicates/end", { itemIds: ["400000002", "400000003"], confirm: true })).json();
    assert.equal(r.ended, 2);
    assert.deepEqual(ended, ["400000002", "400000003"]);
    assert.equal((await Listing.findOne({ storeId: store._id, itemId: "400000002" }).lean())!.active, false);
    assert.equal((await InventoryItem.findOne({ storeId: store._id, itemId: "400000002" }).lean())!.status, "ended");
    // nothing left to dedupe
    assert.equal((await (await fetch(`${base}/duplicates`, { headers })).json()).totals.groups, 0);

    // ignore round-trip
    await Listing.create({ storeId: store._id, itemId: "400000004", title: "BMW X5 Tail Light Left 63217290103 OEM", active: true });
    const again = await (await fetch(`${base}/duplicates`, { headers })).json();
    assert.equal(again.totals.groups, 1);
    await post("/duplicates/ignore", { key: again.groups[0].key });
    const hidden = await (await fetch(`${base}/duplicates`, { headers })).json();
    assert.equal(hidden.totals.groups, 0);
    assert.equal(hidden.ignoredCount, 1);
  } finally {
    server.close();
  }
});

test("keep choice: a copy that's still in stock beats a sold-out one", () => {
  const [g] = findDuplicates([
    { itemId: "500000001", title: "Same Part Title Here", quantitySold: 9, quantityAvailable: 0 },
    { itemId: "500000002", title: "Same Part Title Here", quantitySold: 0, quantityAvailable: 2 },
  ]);
  assert.equal(g.keepItemId, "500000002");
  assert.deepEqual(g.matches, [], "title match is a badge, not repeated text");
});
