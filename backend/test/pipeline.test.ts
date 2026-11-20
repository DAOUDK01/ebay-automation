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
import { Job } from "../src/models/Job";
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
  item_specifics: [{ name: "Manufacturer Part Number", values: ["AC-555"], source: "listing_text", confidence: "high" }],
  recommended_price: 36,
  price_reason: "competitors 35-38",
  compatibility: [{ year: "2016", make: "Honda", model: "Civic", trim: "", engine: "", source: "listing_text", confidence: "high" }],
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
  assert.deepEqual(p1!.changes.compatibilityAdd, [{ Year: "2016", Make: "Honda", Model: "Civic" }], "fitment pushed by default");
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
  const afterPush = await Batch.findById(batch!._id);
  assert.equal(afterPush!.status, "done");
  assert.equal(afterPush!.push?.total, 1, "push progress: total");
  assert.equal(afterPush!.push?.done, 1, "push progress: done");
  assert.equal(afterPush!.push?.failed, 0, "push progress: failed");
  assert.ok(afterPush!.push?.finishedAt, "push progress: finished");
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
  // category aspects unknown -> only well-known part-number specifics can still be added
  assert.deepEqual(p!.changes.itemSpecifics, { Brand: ["Acme"], "Manufacturer Part Number": ["AC-555"] });
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

test("store title format reaches Claude and missing fixed text is rejected", async () => {
  const tpl = "{Year range} {Brand} {Model} {Part name and location} {Part number} OEM Used";
  const sid = String(store._id);
  const saved = await call(`/stores/${sid}`, "PATCH", {
    settings: { ...DEFAULT_SETTINGS, mode: "review", modules: { ...DEFAULT_SETTINGS.modules, title: { enabled: true, template: tpl } } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.store.settings.modules.title.template, tpl);

  let seenTemplate: string | undefined;
  const withFormat: PipelineDeps = {
    ...deps,
    suggest: async (_i, _a, _c, opts) => {
      seenTemplate = opts.titleTemplate;
      return { suggestion: structuredClone(SUGGESTION), costUsd: 0.01, inputTokens: 1, outputTokens: 1 };
    },
  };
  const fresh = (await Store.findById(store._id)) as StoreDocument;
  const batch = await runBatch(fresh, withFormat, { itemIds: ["2"] });
  // the fixture is a NEW Acme (aftermarket) part: the format's "OEM Used" becomes "New" for it
  assert.equal(seenTemplate, "{Year range} {Brand} {Model} {Part name and location} {Part number} New", "format (adapted to the part) is passed to Claude");
  const p = await Proposal.findOne({ batchId: batch!._id, itemId: "2" }).lean();
  assert.equal(p!.part.label, "New · Aftermarket (Acme)");
  assert.equal(p!.changes.title, undefined, "title without the fixed ending is not applied");
  assert.ok(p!.notes.some((n: string) => /missing required text "New"/.test(n)));
});

test("manual edits are revertable: description, quantity and the full fitment list come back", async () => {
  const before = {
    ...ITEM("1", "Old title"),
    quantity: 4,
    quantitySold: 1,
    descriptionHtml: "<p>old</p>",
    compatibilityAll: [{ Year: "2016", Make: "Honda", Model: "Civic" }],
  };
  const p = await Proposal.create({
    storeId: store._id,
    batchId: null,
    kind: "manual",
    itemId: "1",
    status: "pushed",
    before,
    changes: { title: "New title", quantity: 9, description: "<p>new</p>", compatibilityReplace: [] },
    notes: ["manual edit"],
    pushedAt: new Date(),
  });
  const n = revised.length;
  // history API lists manual edits too
  const h = await call(`/stores/${String(store._id)}/proposals?status=pushed`);
  assert.ok(h.json.items.some((x: any) => x._id === String(p._id) && x.kind === "manual"));
  // revert (with the fake eBay client - the API route would call real eBay)
  const reverted = await revertProposal(store, deps, String(p._id));
  assert.equal(reverted.status, "reverted");
  assert.equal(reverted.batchId, null, "manual edit has no batch");
  const sent = revised[n].changes;
  assert.equal(sent.title, "Old title");
  assert.equal(sent.quantity, 4);
  assert.equal(sent.description, "<p>old</p>");
  assert.deepEqual(sent.compatibilityReplace, [{ Year: "2016", Make: "Honda", Model: "Civic" }]);
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

test("batch redo: rejects what's waiting, re-runs the same listings (not pushed ones) in a new batch", async () => {
  const sid = String(store._id);
  await Job.deleteMany({ storeId: store._id });
  const batch = await Batch.create({ storeId: store._id, number: 900, mode: "review", status: "review" });
  const mk = (itemId: string, status: string) => Proposal.create({ storeId: store._id, batchId: batch._id, itemId, status, before: ITEM(itemId, "t") });
  await mk("r1", "proposed");
  await mk("r2", "approved");
  await mk("r3", "pushed");
  await mk("r4", "no_change");
  await mk("r5", "skipped");

  assert.equal((await call(`/stores/${sid}/batches/${batch._id}/redo`, "POST", {})).status, 400, "needs confirm");
  const r = await call(`/stores/${sid}/batches/${batch._id}/redo`, "POST", { confirm: true });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.rejected, 2);
  assert.equal(r.json.count, 3);
  const job = await Job.findOne({ storeId: store._id, type: "batch", status: "queued" }).lean();
  assert.deepEqual([...(job!.payload as any).itemIds].sort(), ["r1", "r2", "r4"], "pushed and skipped listings are left alone");
  const statuses = Object.fromEntries((await Proposal.find({ batchId: batch._id }).lean()).map((p) => [p.itemId, p.status]));
  assert.deepEqual(statuses, { r1: "rejected", r2: "rejected", r3: "pushed", r4: "no_change", r5: "skipped" });

  // another batch already queued: refused, nothing changes
  await Proposal.updateOne({ batchId: batch._id, itemId: "r1" }, { $set: { status: "proposed" } });
  const again = await call(`/stores/${sid}/batches/${batch._id}/redo`, "POST", { confirm: true });
  assert.equal(again.status, 409);
  assert.equal((await Proposal.findOne({ batchId: batch._id, itemId: "r1" }).lean())!.status, "proposed");
  await Job.deleteMany({ storeId: store._id });
});
