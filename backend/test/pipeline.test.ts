/** End-to-end: real MongoDB (in-memory) + real Express app, fake eBay + fake Claude. No network, no cost. */
process.env.JWT_SECRET = "test-secret";
process.env.ENCRYPTION_KEY = "test-key";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { encrypt } from "../src/lib/crypto";
import type { ClaudeSuggestion } from "../src/lib/claude";
import type { EbayItem, ListingChanges } from "../src/lib/ebay/types";
import { Batch } from "../src/models/Batch";
import { Listing } from "../src/models/Listing";
import { Proposal } from "../src/models/Proposal";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import { monthSpend } from "../src/models/Usage";
import { pushProposals, revertProposal, runBatch, syncListings, type PipelineDeps } from "../src/services/pipeline";

const ITEM = (id: string, title: string): EbayItem => ({
  itemId: id, title, subtitle: "", sku: `SKU-${id}`, listingType: "FixedPriceItem", categoryId: "33572",
  categoryName: "Brake Pads", conditionId: "1000", condition: "New", price: 40, currency: "USD", quantity: 5,
  quantitySold: 0, watchCount: 0, hasVariations: false, variationNames: [], itemSpecifics: { Brand: ["Acme"] },
  compatibilityCount: 0, compatibilitySample: [], shipping: { options: [], dispatchDays: "1", policy: "", location: "" },
  pictureCount: 3, imageUrl: "", descriptionText: "Fits 2016-2017 Honda Civic. MPN AC-555", url: "",
  site: "eBayMotors",
});

const SUGGESTION: ClaudeSuggestion = {
  title: "Acme Front Ceramic Brake Pad Set for 2016-2017 Honda Civic AC-555",
  title_reason: "brand + MPN + fitment",
  item_specifics: [{ name: "Manufacturer Part Number", values: ["AC-555"], source: "description" }],
  recommended_price: 36,
  price_reason: "competitors 35-38",
  compatibility: [{ year: "2016", make: "Honda", model: "Civic", trim: "", engine: "" }],
  shipping_notes: "",
  other_notes: "",
  confidence: "high",
};

const revised: { itemId: string; changes: ListingChanges; site?: string }[] = [];
const deps: PipelineDeps = {
  trading: {
    allActiveListings: async () =>
      ["1", "2", "3"].map((id) => ({
        itemId: id, title: `Brake Pad Set Front Ceramic ${id}`, sku: `SKU-${id}`, price: 40, quantitySold: 0,
        watchCount: 0, listingType: "FixedPriceItem", imageUrl: "",
      })),
    getItem: async (id) => {
      if (id === "3") throw new Error("eBay says no");
      return ITEM(id, `Brake Pad Set Front Ceramic ${id}`);
    },
    reviseItem: async (itemId, changes, site) => {
      revised.push({ itemId, changes, site });
      return [];
    },
  },
  rest: {
    aspectsForCategory: async () => [
      { name: "Brand", required: true, usage: "RECOMMENDED", mode: "FREE_TEXT", multi: false, values: [] },
      { name: "Manufacturer Part Number", required: false, usage: "RECOMMENDED", mode: "FREE_TEXT", multi: false, values: [] },
    ],
    competitorsFor: async () => ({ query: "AC-555", competitors: [] }),
  },
  suggest: async () => ({ suggestion: structuredClone(SUGGESTION), costUsd: 0.05, inputTokens: 5000, outputTokens: 1500 }),
  sleep: async () => {},
};

let mongo: MongoMemoryServer;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let cookie = "";
let store: StoreDocument;

async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test("auth: register, me, wrong password", async () => {
  let r = await call("/auth/register", "POST", { email: "Seller@Example.com", password: "password123", name: "S" });
  assert.equal(r.status, 201);
  r = await call("/auth/me");
  assert.equal(r.json.user.email, "seller@example.com");
  const bad = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "seller@example.com", password: "nope" }) });
  assert.equal(bad.status, 401);
  const anon = await fetch(base + "/stores");
  assert.equal(anon.status, 401);
});

test("sync + review-mode batch + approve + push + revert", async () => {
  const me = await call("/auth/me");
  store = (await Store.create({
    userId: me.json.user.id,
    ebayUserId: "acme_parts",
    name: "Acme Parts",
    auth: { refreshTokenEnc: encrypt("refresh-token"), scopes: [] },
    settings: { ...structuredClone(DEFAULT_SETTINGS), excludeSeller: "acme_parts" },
  })) as StoreDocument;

  assert.equal(await syncListings(store, deps), 3);
  await Listing.updateOne({ storeId: store._id, itemId: "2" }, { $set: { cost: 30 } });

  const batch = await runBatch(store, deps, { limit: 10 });
  assert.ok(batch);
  assert.equal(batch!.status, "review");
  assert.equal(batch!.counts.processed, 3);
  assert.equal(batch!.counts.proposed, 2);
  assert.equal(batch!.counts.errors, 1);
  assert.equal(revised.length, 0, "review mode must not push");
  assert.ok(Math.abs((await monthSpend(store._id)) - 0.1) < 1e-9);

  const p1 = await Proposal.findOne({ batchId: batch!._id, itemId: "1" }).lean();
  const p2 = await Proposal.findOne({ batchId: batch!._id, itemId: "2" }).lean();
  assert.equal(p1!.changes.title, SUGGESTION.title);
  assert.equal(p1!.changes.price, undefined, "no cost -> no price decrease");
  assert.equal(p2!.changes.price, 39.88, "cost 30 -> floored at 39.88");
  assert.deepEqual(p1!.changes.itemSpecifics, { Brand: ["Acme"], "Manufacturer Part Number": ["AC-555"] });
  assert.equal(p1!.changes.compatibilityAdd, undefined, "fitment report-only by default");
  assert.equal(p1!.suggestion.suggested_compatibility_rows.length, 1);

  // API: list batch, edit + approve one, reject another
  const sid = String(store._id);
  let r = await call(`/stores/${sid}/batches/${batch!._id}`);
  assert.equal(r.json.proposals.length, 3);
  r = await call(`/stores/${sid}/proposals/${p1!._id}`, "PATCH", { title: "Acme Ceramic Front Brake Pads 2016-2017 Honda Civic AC-555", status: "approved" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call(`/stores/${sid}/proposals/${p2!._id}`, "PATCH", { status: "rejected" });
  assert.equal(r.status, 200);
  r = await call(`/stores/${sid}/proposals/${p2!._id}`, "PATCH", { title: "x".repeat(81) });
  assert.equal(r.status, 400, "title > 80 rejected by API");

  // push request goes to the job queue
  r = await call(`/stores/${sid}/batches/${batch!._id}/push`, "POST");
  assert.equal(r.status, 202);
  assert.equal(r.json.approved, 1);
  // the worker would now run:
  await pushProposals(store, deps, batch!._id, ["approved"]);
  assert.equal(revised.length, 1);
  assert.equal(revised[0].itemId, "1");
  assert.equal(revised[0].site, "eBayMotors", "revise goes to the listing's own eBay site");
  assert.equal(revised[0].changes.title, "Acme Ceramic Front Brake Pads 2016-2017 Honda Civic AC-555");
  assert.equal((await Batch.findById(batch!._id))!.status, "done");
  assert.equal((await Listing.findOne({ storeId: store._id, itemId: "1" }))!.title, "Acme Ceramic Front Brake Pads 2016-2017 Honda Civic AC-555");

  // revert restores the snapshot
  await revertProposal(store, deps, String(p1!._id));
  assert.equal(revised[1].changes.title, "Brake Pad Set Front Ceramic 1");
  assert.deepEqual(revised[1].changes.itemSpecifics, { Brand: ["Acme"] });
  assert.equal((await Proposal.findById(p1!._id))!.status, "reverted");

  // the failed listing is not put on the 21-day cooldown - only a short retry delay
  const failedListing = await Listing.findOne({ storeId: store._id, itemId: "3" }).lean();
  assert.equal(failedListing!.lastProcessedAt, null);
  assert.ok(failedListing!.lastErrorAt instanceof Date);

  // cooldown: nothing due now (1,2 processed; 3 failed less than 24h ago)
  assert.equal(await runBatch(store, deps, { limit: 10 }), null);

  // history + overview endpoints
  r = await call(`/stores/${sid}/proposals?status=reverted`);
  assert.equal(r.json.total, 1);
  r = await call(`/stores/${sid}`);
  assert.equal(r.json.store.stats.activeListings, 3);
  assert.equal(r.json.store.stats.processedListings, 2, "the failed listing doesn't count as optimized");
});

test("auto mode pushes at the end of the batch; settings validation", async () => {
  const sid = String(store._id);
  const bad = await call(`/stores/${sid}`, "PATCH", { settings: { ...DEFAULT_SETTINGS, batchSize: 0 } });
  assert.equal(bad.status, 400);
  const ok = await call(`/stores/${sid}`, "PATCH", { settings: { ...DEFAULT_SETTINGS, mode: "auto" } });
  assert.equal(ok.status, 200);
  const fresh = (await Store.findById(store._id)) as StoreDocument;
  const before = revised.length;
  const batch = await runBatch(fresh, deps, { itemIds: ["1"] });
  assert.equal(batch!.status, "done");
  assert.equal(revised.length, before + 1);
});

test("a failed category lookup does not sink the listing; retry-errors re-queues failures", async () => {
  const noAspects: PipelineDeps = {
    ...deps,
    rest: {
      ...deps.rest,
      aspectsForCategory: async () => {
        throw new Error("GET .../get_item_aspects_for_category -> 400: 62005 does not belong to specified category tree");
      },
    },
  };
  const fresh = (await Store.findById(store._id)) as StoreDocument;
  const batch = await runBatch(fresh, noAspects, { itemIds: ["2"] });
  const p = await Proposal.findOne({ batchId: batch!._id, itemId: "2" }).lean();
  assert.notEqual(p!.status, "error");
  assert.ok(p!.notes.some((n: string) => n.startsWith("item specifics skipped")));
  assert.equal(p!.changes.itemSpecifics, undefined);
  assert.ok(p!.changes.title, "title still optimized");

  // retry endpoint: batch #1 had one failed listing ("3")
  const first = await Batch.findOne({ storeId: store._id, number: 1 });
  const r = await call(`/stores/${String(store._id)}/batches/${first!._id}/retry-errors`, "POST");
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.count, 1);
  assert.deepEqual(r.json.job.payload.itemIds, ["3"]);
  const again = await call(`/stores/${String(store._id)}/batches/${first!._id}/retry-errors`, "POST");
  assert.equal(again.status, 409, "second retry while one is queued is refused");
});

test("costs CSV import + store isolation", async () => {
  const sid = String(store._id);
  const r = await call(`/stores/${sid}/listings/costs`, "POST", { csv: "id,cost\nSKU-1,12.5\n3,9\nnope,1\nSKU-2,abc" });
  assert.equal(r.status, 200);
  assert.equal(r.json.updated, 2);
  assert.equal(r.json.unmatchedCount, 1);
  assert.equal(r.json.invalid.length, 1);
  assert.equal((await Listing.findOne({ storeId: store._id, itemId: "1" }))!.cost, 12.5);
  const patched = await call(`/stores/${sid}/listings/1`, "PATCH", { cost: 14 });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.listing.cost, 14, "findOneAndUpdate returns the updated doc");

  // another user cannot see this store
  const other = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "other@example.com", password: "password123" }),
  });
  const otherCookie = other.headers.get("set-cookie")!.split(";")[0];
  const res = await fetch(`${base}/stores/${sid}`, { headers: { cookie: otherCookie } });
  assert.equal(res.status, 404);
});
