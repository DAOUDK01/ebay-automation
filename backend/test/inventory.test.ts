/** Inventory module: GetMyeBaySelling mapping, low-stock counts, ReviseInventoryStatus batching (4 per call), relist/end API. */
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
import inventoryModule from "../src/modules/inventory";
import { chunk, reviseInventory } from "../src/modules/inventory/ebay";
import { InventoryItem, InventorySettings } from "../src/modules/inventory/model";
import { inventoryRouter } from "../src/modules/inventory/routes";
import { inventoryCounts } from "../src/modules/inventory/service";
import { runAccountSync } from "../src/services/accountSync";
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

const makeStore = (userId = new mongoose.Types.ObjectId()) =>
  Store.create({
    userId,
    ebayUserId: "my_shop",
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: [] },
    settings: structuredClone(DEFAULT_SETTINGS),
  }) as Promise<StoreDocument>;

const item = (id: string, o: { qty: number; sold: number; avail?: number; watch?: number; sku?: string; variations?: boolean; type?: string }) =>
  `<Item><ItemID>${id}</ItemID><Title>Part ${id}</Title><SKU>${o.sku ?? "SKU-" + id}</SKU><Quantity>${o.qty}</Quantity>` +
  (o.avail !== undefined ? `<QuantityAvailable>${o.avail}</QuantityAvailable>` : "") +
  `<SellingStatus><CurrentPrice currencyID="USD">19.99</CurrentPrice><QuantitySold>${o.sold}</QuantitySold></SellingStatus>` +
  `<WatchCount>${o.watch ?? 0}</WatchCount><ListingType>${o.type ?? "FixedPriceItem"}</ListingType>` +
  `<PictureDetails><GalleryURL>https://img/${id}.jpg</GalleryURL></PictureDetails>` +
  `<ListingDetails><ViewItemURL>https://www.ebay.com/itm/${id}</ViewItemURL><EndTime>2026-11-01T10:00:00.000Z</EndTime></ListingDetails>` +
  (o.variations ? `<Variations><Variation><SKU>v1</SKU></Variation></Variations>` : "") +
  `</Item>`;

const page = (n: number, pages: number) => `<PaginationResult><TotalNumberOfPages>${pages}</TotalNumberOfPages></PaginationResult>`;

function ebay() {
  return fakeTrading({
    GetMyeBaySelling: (xml, n) => {
      const p = Number(/<PageNumber>(\d+)</.exec(xml)![1]);
      if (xml.includes("<ActiveList>")) {
        // two pages of active listings
        const items = p === 1
          ? item("1", { qty: 5, sold: 5, avail: 0, watch: 3 }) + item("2", { qty: 3, sold: 2, avail: 1 })
          : item("3", { qty: 10, sold: 2 }) + item("4", { qty: 4, sold: 0, avail: 4, variations: true });
        return `<ActiveList><ItemArray>${items}</ItemArray>${page(p, 2)}</ActiveList>`;
      }
      if (xml.includes("<UnsoldList>")) return `<UnsoldList><ItemArray>${item("7", { qty: 2, sold: 0 })}</ItemArray>${page(1, 1)}</UnsoldList>`;
      void n;
      // sold: an Order (item 2 - still active) and a single Transaction (item 8 - sold out and ended)
      return `<SoldList><OrderTransactionArray>` +
        `<OrderTransaction><Order><TransactionArray><Transaction>${item("2", { qty: 3, sold: 2 })}</Transaction></TransactionArray></Order></OrderTransaction>` +
        `<OrderTransaction><Transaction><QuantityPurchased>1</QuantityPurchased>${item("8", { qty: 1, sold: 1 })}</Transaction></OrderTransaction>` +
        `</OrderTransactionArray>${page(1, 1)}</SoldList>`;
    },
  });
}

test("sync: maps active/unsold/sold lists with quantity details; ended listings drop out of active", async () => {
  const store = await makeStore();
  await InventoryItem.create({ storeId: store._id, itemId: "99", title: "Ended elsewhere", status: "active", quantityAvailable: 3 });
  const fake = ebay();
  const runs = await runAccountSync(store, ["inventory"], { trading: fake } as any);
  assert.equal(runs[0].ok, true, runs[0].summary);
  assert.match(runs[0].summary, /4 active \(2 low\/out of stock\), 1 unsold, 2 sold, 1 ended/);
  assert.equal(fake.callsTo("GetMyeBaySelling").length, 4, "2 active pages + unsold + sold");

  const rows = Object.fromEntries((await InventoryItem.find({ storeId: store._id }).lean()).map((r) => [r.itemId, r]));
  assert.deepEqual(
    Object.keys(rows).sort().map((id) => [id, rows[id].status, rows[id].quantityAvailable]),
    [["1", "active", 0], ["2", "active", 1], ["3", "active", 8], ["4", "active", 4], ["7", "unsold", 0], ["8", "ended", 0], ["99", "ended", 0]],
  );
  const r1 = rows["1"];
  assert.deepEqual([r1.quantity, r1.quantitySold, r1.watchers, r1.price, r1.sku, r1.imageUrl], [5, 5, 3, 19.99, "SKU-1", "https://img/1.jpg"]);
  assert.equal(rows["3"].quantityAvailable, 8, "no QuantityAvailable -> quantity - sold");
  assert.equal(rows["4"].hasVariations, true);
  assert.equal(rows["2"].status, "active", "active list wins over the sold list");

  // low stock = active with available <= threshold (default 1): items 1 (0) and 2 (1)
  assert.deepEqual(await inventoryCounts(store), { lowStock: 2 });
  await InventorySettings.updateOne({ storeId: store._id }, { $set: { lowStockThreshold: 4 } });
  assert.deepEqual(await inventoryCounts(store), { lowStock: 3 });
});

test("ReviseInventoryStatus: groups of 4, per-item results, a failing group is retried item by item", async () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9], 4), [[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
  const fake = fakeTrading({
    ReviseInventoryStatus: (xml) => {
      const ids = [...xml.matchAll(/<ItemID>(\w+)<\/ItemID>/g)].map((m) => m[1]);
      if (ids.includes("bad")) return new Error("ReviseInventoryStatus failed: [21916] bad price");
      return ids.map((id) => `<InventoryStatus><ItemID>${id}</ItemID></InventoryStatus>`).join("");
    },
  });
  const changes = ["a", "b", "c", "d", "e", "bad", "g", "h", "i"].map((itemId, i) => ({ itemId, quantity: i, ...(i === 0 ? { price: 12.5 } : {}) }));
  const results = await reviseInventory(fake, changes);
  assert.deepEqual(results.map((r) => [r.itemId, r.ok]), changes.map((c) => [c.itemId, c.itemId !== "bad"]));
  assert.match(results[5].error!, /bad price/);
  const sizes = fake.calls.map((c) => (c.xml.match(/<InventoryStatus>/g) ?? []).length);
  // a-d, then e/bad/g/h fails -> e, bad, g, h one by one, then i
  assert.deepEqual(sizes, [4, 4, 1, 1, 1, 1, 1]);
  assert.match(fake.calls[0].xml, /<ItemID>a<\/ItemID><Quantity>0<\/Quantity><StartPrice>12.50<\/StartPrice>/);
  assert.ok(sizes.every((n) => n <= 4));
});

test("API: tabs + search, bulk revise, relist and end", async () => {
  const userId = new mongoose.Types.ObjectId();
  const store = await makeStore(userId);
  const fake = ebay();
  await runAccountSync(store, ["inventory"], { trading: fake } as any);
  await Listing.create({ storeId: store._id, itemId: "2", title: "Part 2", price: 19.99 });

  const writes = fakeTrading({
    ReviseInventoryStatus: (xml) =>
      [...xml.matchAll(/<ItemID>(\w+)<\/ItemID>/g)].map((m) => `<InventoryStatus><ItemID>${m[1]}</ItemID></InventoryStatus>`).join(""),
    RelistFixedPriceItem: () => `<ItemID>7000</ItemID>`,
    EndFixedPriceItem: () => `<EndTime>2026-11-20T12:00:00.000Z</EndTime>`,
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/stores/:storeId/inventory", requireAuth, inventoryRouter(() => writes));
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stores/${store._id}/inventory`;
  const headers = { cookie: `${AUTH_COOKIE}=${signSession(String(userId))}`, "Content-Type": "application/json" };
  const get = async (p: string) => (await fetch(base + p, { headers })).json();
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const out = await get("?tab=out");
    assert.deepEqual(out.items.map((i: any) => i.itemId), ["1"]);
    assert.deepEqual(out.tabs, { out: 1, low: 1, active: 4, ended: 2 });
    assert.deepEqual((await get("?tab=low")).items.map((i: any) => i.itemId), ["2"]);
    assert.deepEqual((await get("?q=sku-7")).items.map((i: any) => i.itemId), ["7"], "search covers every tab");

    const rev = await (await post("/revise", {
      changes: [{ itemId: "1", quantity: 6 }, { itemId: "2", price: 24.5 }, { itemId: "7", quantity: 1 }, { itemId: "4", quantity: 9 }],
    })).json();
    assert.deepEqual(rev.results.map((r: any) => [r.itemId, r.ok]), [["1", true], ["2", true], ["7", false], ["4", false]]);
    assert.match(rev.results[2].error, /relist/);
    assert.equal(writes.callsTo("ReviseInventoryStatus").length, 1, "two valid items -> one call");
    const one = await InventoryItem.findOne({ storeId: store._id, itemId: "1" }).lean();
    assert.deepEqual([one?.quantityAvailable, one?.quantity], [6, 11]);
    assert.equal((await Listing.findOne({ storeId: store._id, itemId: "2" }).lean())?.price, 24.5);
    assert.equal((await post("/revise", { changes: [{ itemId: "1" }] })).status, 400, "nothing to change");

    assert.equal((await post("/1/relist", {})).status, 400, "active can't be relisted");
    const rl = await (await post("/7/relist", {})).json();
    assert.equal(rl.newItemId, "7000");
    assert.equal((await InventoryItem.findOne({ storeId: store._id, itemId: "7000" }).lean())?.status, "active");
    assert.equal((await post("/7/relist", {})).status, 400, "only once");

    assert.equal((await post("/2/end", { reason: "Whatever" })).status, 400);
    assert.equal((await post("/2/end", { reason: "NotAvailable" })).status, 200);
    assert.match(writes.callsTo("EndFixedPriceItem")[0].xml, /<ItemID>2<\/ItemID><EndingReason>NotAvailable<\/EndingReason>/);
    assert.equal((await InventoryItem.findOne({ storeId: store._id, itemId: "2" }).lean())?.status, "ended");
    assert.equal((await Listing.findOne({ storeId: store._id, itemId: "2" }).lean())?.active, false);
  } finally {
    server.close();
  }
});

test("module is ready", () => {
  assert.equal(inventoryModule.ready, true);
  assert.ok(inventoryModule.sync && inventoryModule.counts && inventoryModule.router);
});
