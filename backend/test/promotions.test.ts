/** Promotions module: payloads, sync, counts, and the confirm-gated write API. */
process.env.JWT_SECRET = "test-secret";
process.env.ENCRYPTION_KEY = "test-key";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { encrypt } from "../src/lib/crypto";
import { USER_SCOPES } from "../src/lib/ebay/auth";
import { Listing } from "../src/models/Listing";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import { FinTransaction } from "../src/modules/finances/models";
import promotions from "../src/modules/promotions";
import { buildBulkAdsPayloads, buildCampaignPayload, canDo } from "../src/modules/promotions/logic";
import { Ad, Campaign, ItemPromotion } from "../src/modules/promotions/models";
import { marketing } from "../src/modules/promotions/routes";
import { syncPromotions } from "../src/modules/promotions/sync";
import type { SyncContext } from "../src/modules/types";

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
    ebayUserId: `seller${Math.random()}`,
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: USER_SCOPES },
    settings: structuredClone(DEFAULT_SETTINGS),
  }) as Promise<StoreDocument>;

test("campaign payload: Promoted Listings Standard, CPS, decimal ad rate, start never in the past", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const p = buildCampaignPayload({ name: "  Brakes Q4 ", bidPercentage: 5, startDate: "2026-12-01", endDate: "2026-12-31" }, "EBAY_US", now);
  assert.deepEqual(p, {
    campaignName: "Brakes Q4",
    marketplaceId: "EBAY_US",
    startDate: "2026-12-01T00:00:00.000Z",
    endDate: "2026-12-31T23:59:59.000Z",
    fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "5.0" },
  });
  const today = buildCampaignPayload({ name: "Now", bidPercentage: 7.25, startDate: "2026-11-20" }, "EBAY_US", now);
  assert.equal(today.startDate, "2026-11-20T12:05:00.000Z");
  assert.equal(today.fundingStrategy.bidPercentage, "7.3");
  assert.equal("endDate" in today, false);
  assert.throws(() => buildCampaignPayload({ name: "x", bidPercentage: 1, startDate: "2026-12-01" }, "EBAY_US", now), /between 2% and 100%/);
  assert.throws(() => buildCampaignPayload({ name: "x", bidPercentage: 5, startDate: "2026-12-05", endDate: "2026-12-01" }, "EBAY_US", now), /after the start/);
});

test("bulk ads payload: deduped, invalid ids dropped, chunks of 500", () => {
  const ids = Array.from({ length: 501 }, (_, i) => String(256100000000 + i));
  const p = buildBulkAdsPayloads([...ids, ids[0], "abc", ""], 6);
  assert.equal(p.length, 2);
  assert.equal(p[0].requests.length, 500);
  assert.deepEqual(p[1].requests, [{ listingId: "256100000500", bidPercentage: "6.0" }]);
  assert.ok(canDo("RUNNING", "pause") && canDo("PAUSED", "resume") && canDo("PAUSED", "end"));
  assert.ok(!canDo("ENDED", "end") && !canDo("RUNNING", "resume"));
});

/** Fake Marketing API (SellClient-shaped) that records writes and keeps campaign state. */
function fakeMarketing() {
  const campaigns: any[] = [
    { campaignId: "C1", campaignName: "Brakes", campaignStatus: "RUNNING", fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "5.0" }, startDate: "2026-10-01T00:00:00Z", marketplaceId: "EBAY_US" },
    { campaignId: "C2", campaignName: "Old", campaignStatus: "ENDED", fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "3.0" } },
  ];
  const ads: Record<string, any[]> = { C1: [{ adId: "A1", listingId: "256100000001", bidPercentage: "5.0", adStatus: "ACTIVE" }] };
  const posts: { path: string; body: any }[] = [];
  return {
    campaigns,
    ads,
    posts,
    async get(path: string, query: any = {}) {
      if (path.endsWith("get_campaign_by_name")) return campaigns.find((c) => c.campaignName === query.campaign_name);
      const id = /ad_campaign\/([^/]+)$/.exec(path)?.[1];
      if (id) return campaigns.find((c) => c.campaignId === id);
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string, body?: any) {
      posts.push({ path, body });
      if (path.endsWith("/ad_campaign")) {
        campaigns.push({ campaignId: "C9", campaignName: body.campaignName, campaignStatus: "SCHEDULED", fundingStrategy: body.fundingStrategy, startDate: body.startDate });
        return null;
      }
      const m = /ad_campaign\/([^/]+)\/(pause|resume|end|bulk_create_ads_by_listing_id)$/.exec(path)!;
      const c = campaigns.find((x) => x.campaignId === m[1]);
      if (m[2] === "pause") c.campaignStatus = "PAUSED";
      if (m[2] === "resume") c.campaignStatus = "RUNNING";
      if (m[2] === "end") c.campaignStatus = "ENDED";
      if (m[2] === "bulk_create_ads_by_listing_id") {
        return {
          responses: body.requests.map((r: any, i: number) => {
            if (i === 1) return { listingId: r.listingId, statusCode: 400, errors: [{ message: "Listing already in a campaign" }] };
            (ads[c.campaignId] ??= []).push({ adId: `A-${r.listingId}`, listingId: r.listingId, bidPercentage: r.bidPercentage, adStatus: "ACTIVE" });
            return { listingId: r.listingId, adId: `A-${r.listingId}`, statusCode: 201 };
          }),
        };
      }
      return null;
    },
    async *paged(path: string, _key: string, query: any = {}) {
      if (path.endsWith("/ad_campaign")) yield* campaigns;
      else if (path.endsWith("/promotion")) {
        assert.equal(query.marketplace_id, "EBAY_US");
        yield { promotionId: "PR1", name: "20% off rotors", promotionType: "MARKDOWN_SALE", promotionStatus: "RUNNING", startDate: "2026-11-01T00:00:00Z" };
      } else yield* ads[/ad_campaign\/([^/]+)\/ad$/.exec(path)![1]] ?? [];
    },
  };
}

const ctxFor = (store: StoreDocument, sell: any): SyncContext => ({
  store,
  clients: { sell, trading: {} as any, postOrder: {} as any },
  cursor: null,
  lastSuccessAt: null,
  log: () => {},
});

test("sync: campaigns with ads, item promotions, removed campaigns dropped, counts", async () => {
  const store = await makeStore();
  await Campaign.create({ storeId: store._id, campaignId: "GONE", status: "RUNNING" });
  const fake = fakeMarketing();
  const r = await syncPromotions(ctxFor(store, fake));
  assert.equal(r.summary, "2 campaigns (1 running), 1 item promotions");
  const c1 = await Campaign.findOne({ storeId: store._id, campaignId: "C1" }).lean();
  assert.equal(c1?.bidPercentage, 5);
  assert.equal(c1?.adCount, 1);
  assert.equal(c1?.fundingModel, "COST_PER_SALE");
  assert.equal(await Campaign.countDocuments({ storeId: store._id, campaignId: "GONE" }), 0);
  assert.equal((await Ad.findOne({ storeId: store._id, adId: "A1" }).lean())?.listingId, "256100000001");
  assert.equal((await ItemPromotion.findOne({ storeId: store._id }).lean())?.type, "MARKDOWN_SALE");
  assert.deepEqual(await promotions.counts!(store), { activeCampaigns: 1 });
});

test("API: writes need confirm, then send the right eBay calls; guards on status and ownership", async () => {
  const fake = fakeMarketing();
  const original = marketing.clientFor;
  marketing.clientFor = () => fake as any;
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const reg = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `p${Date.now()}@x.test`, password: "password-123", name: "P" }),
    });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
    const store = await makeStore(me.user.id ?? me.user._id);
    await syncPromotions(ctxFor(store, fake));
    await Listing.create([
      { storeId: store._id, itemId: "256100000002", title: "Rotor", active: true },
      { storeId: store._id, itemId: "256100000003", title: "Filter", active: true },
    ]);
    await FinTransaction.create({ storeId: store._id, transactionId: "AF1", type: "NON_SALE_CHARGE", feeType: "AD_FEE", date: new Date(), amount: -3.5, itemIds: ["256100000001"], orderId: "O1" });
    const post = (p: string, body: any) =>
      fetch(`${base}/stores/${store._id}/promotions${p}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    // no confirm -> nothing sent
    const noConfirm = await post("/campaigns", { name: "New", bidPercentage: 5, startDate: "2030-01-01" });
    assert.equal(noConfirm.status, 400);
    assert.equal(fake.posts.length, 0);

    const created = await post("/campaigns", { name: "New", bidPercentage: 5, startDate: "2030-01-01", confirm: true });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).campaign.campaignId, "C9");
    assert.deepEqual(fake.posts[0], {
      path: "/sell/marketing/v1/ad_campaign",
      body: { campaignName: "New", marketplaceId: "EBAY_US", startDate: "2030-01-01T00:00:00.000Z", fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "5.0" } },
    });

    assert.equal((await post("/campaigns/C1/pause", {})).status, 400, "pause needs confirm too");
    const paused = await post("/campaigns/C1/pause", { confirm: true });
    assert.equal((await paused.json()).campaign.status, "PAUSED");
    assert.equal(fake.posts.at(-1)!.path, "/sell/marketing/v1/ad_campaign/C1/pause");
    assert.equal((await post("/campaigns/C1/pause", { confirm: true })).status, 409, "already paused");
    assert.equal((await post("/campaigns/C2/end", { confirm: true })).status, 409, "already ended");
    assert.equal((await post("/campaigns/C1/explode", { confirm: true })).status, 404);

    const n = fake.posts.length;
    assert.equal((await post("/campaigns/C1/ads", { listingIds: ["999999999999"], bidPercentage: 6, confirm: true })).status, 400, "not this account's listing");
    assert.equal(fake.posts.length, n);
    const added = await (await post("/campaigns/C1/ads", { listingIds: ["256100000002", "256100000003", "999999999999"], bidPercentage: 6.5, confirm: true })).json();
    assert.deepEqual(fake.posts.at(-1), {
      path: "/sell/marketing/v1/ad_campaign/C1/bulk_create_ads_by_listing_id",
      body: { requests: [{ listingId: "256100000002", bidPercentage: "6.5" }, { listingId: "256100000003", bidPercentage: "6.5" }] },
    });
    assert.deepEqual(added.results.map((r: any) => [r.listingId, r.ok]), [["256100000002", true], ["256100000003", false]]);
    assert.equal(added.campaign.adCount, 2);

    const list = await (await fetch(`${base}/stores/${store._id}/promotions/campaigns`, { headers: { cookie } })).json();
    const c1 = list.campaigns.find((c: any) => c.campaignId === "C1");
    assert.equal(c1.adFees30d, 3.5);
    assert.equal(c1.promotedSales30d, 1);
    const search = await (await fetch(`${base}/stores/${store._id}/promotions/listing-search?q=rotor`, { headers: { cookie } })).json();
    assert.deepEqual(search.listings.map((l: any) => [l.itemId, l.campaignId]), [["256100000002", "C1"]]);
  } finally {
    marketing.clientFor = original;
    server.close();
  }
});

test("campaign edits: payloads for rename/dates, ad-rate changes and removals", async () => {
  const { buildIdentificationPayload, buildBulkDeletePayloads, buildBulkBidPayloads } = await import("../src/modules/promotions/logic");
  const now = new Date("2026-11-20T10:00:00Z");
  // running campaign: start date kept, name + end date change
  const running = buildIdentificationPayload({ name: " Brakes Q1 ", startDate: "2027-01-01", endDate: "2027-03-31" }, { startDate: "2026-10-01T00:00:00Z", status: "RUNNING" }, now);
  assert.deepEqual(running, { campaignName: "Brakes Q1", startDate: "2026-10-01T00:00:00.000Z", endDate: "2027-03-31T23:59:59.000Z" });
  // scheduled campaign: start can move; no end date = open-ended
  const scheduled = buildIdentificationPayload({ name: "Later", startDate: "2027-02-01", endDate: "" }, { startDate: "2027-01-01", status: "SCHEDULED" }, now);
  assert.equal(scheduled.startDate, "2027-02-01T00:00:00.000Z");
  assert.equal("endDate" in scheduled, false);
  assert.throws(() => buildIdentificationPayload({ name: "x", endDate: "2026-01-01" }, { startDate: "2025-01-01", status: "RUNNING" }, now), /future/);
  assert.throws(() => buildIdentificationPayload({ name: "  " }, { status: "RUNNING" }, now), /name/);
  assert.deepEqual(buildBulkDeletePayloads(["256100000001", "256100000001", "bad"]), [{ requests: [{ listingId: "256100000001" }] }]);
  assert.deepEqual(buildBulkBidPayloads(["256100000001"], 7.25), [{ requests: [{ listingId: "256100000001", bidPercentage: "7.3" }] }]);
});

test("API: edit campaign, change ad rates (selected / all), remove listings - confirm-gated, only own ads", async () => {
  const campaigns: any[] = [
    { campaignId: "E1", campaignName: "Brakes", campaignStatus: "RUNNING", fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "5.0" }, startDate: "2026-10-01T00:00:00Z" },
  ];
  const ads: any[] = [
    { adId: "A1", listingId: "256100000011", bidPercentage: "5.0", adStatus: "ACTIVE" },
    { adId: "A2", listingId: "256100000012", bidPercentage: "5.0", adStatus: "ACTIVE" },
  ];
  const posts: { path: string; body: any }[] = [];
  const fake = {
    async get(path: string) {
      return campaigns.find((c) => path.endsWith(`/ad_campaign/${c.campaignId}`));
    },
    async post(path: string, body: any) {
      posts.push({ path, body });
      if (path.endsWith("update_campaign_identification")) {
        Object.assign(campaigns[0], { campaignName: body.campaignName, endDate: body.endDate });
        return null;
      }
      if (path.endsWith("bulk_update_ads_bid_by_listing_id")) {
        for (const r of body.requests) ads.find((a) => a.listingId === r.listingId).bidPercentage = r.bidPercentage;
        return { responses: body.requests.map((r: any) => ({ listingId: r.listingId, statusCode: 200 })) };
      }
      if (path.endsWith("bulk_delete_ads_by_listing_id")) {
        for (const r of body.requests) ads.splice(ads.findIndex((a) => a.listingId === r.listingId), 1);
        return { responses: body.requests.map((r: any) => ({ listingId: r.listingId, statusCode: 200 })) };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async *paged(path: string) {
      if (path.endsWith("/ad")) yield* ads;
      else if (path.endsWith("/ad_campaign")) yield* campaigns;
    },
  };
  const original = marketing.clientFor;
  marketing.clientFor = () => fake as any;
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const reg = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `e${Date.now()}@x.test`, password: "password-123", name: "E" }),
    });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
    const store = await makeStore(me.user.id ?? me.user._id);
    const { refreshCampaign } = await import("../src/modules/promotions/sync");
    await refreshCampaign(fake as any, store._id, campaigns[0]);
    const call = (method: string, p: string, body: any) =>
      fetch(`${base}/stores/${store._id}/promotions/campaigns/E1${p}`, { method, headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    assert.equal((await call("PATCH", "", { name: "Renamed" })).status, 400, "needs confirm");
    assert.equal(posts.length, 0);
    const edited = await call("PATCH", "", { name: "Brakes - winter", endDate: "2030-01-31", confirm: true });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).campaign.name, "Brakes - winter");
    assert.equal(posts[0].body.startDate, "2026-10-01T00:00:00.000Z", "running campaign keeps its start");

    // selected listings; a listing not in the campaign is ignored
    const sel = await call("POST", "/ads/bid", { listingIds: ["256100000011", "999999999999"], bidPercentage: 8, confirm: true });
    assert.equal(sel.status, 200);
    assert.deepEqual(posts[1].body.requests, [{ listingId: "256100000011", bidPercentage: "8.0" }]);
    const allRes = await call("POST", "/ads/bid", { all: true, bidPercentage: 6.5, confirm: true });
    assert.equal(allRes.status, 200);
    assert.equal(posts[2].body.requests.length, 2);
    assert.equal((await call("POST", "/ads/bid", { listingIds: ["999999999999"], bidPercentage: 6, confirm: true })).status, 400);
    assert.equal((await call("POST", "/ads/bid", { all: true, bidPercentage: 1, confirm: true })).status, 400, "below 2%");

    const removed = await call("POST", "/ads/remove", { listingIds: ["256100000012"], confirm: true });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).campaign.adCount, 1);
    assert.equal(await Ad.countDocuments({ storeId: store._id, campaignId: "E1" }), 1);

    // ended campaigns can't be changed
    await Campaign.updateOne({ storeId: store._id, campaignId: "E1" }, { $set: { status: "ENDED" } });
    assert.equal((await call("PATCH", "", { name: "x", confirm: true })).status, 409);
  } finally {
    marketing.clientFor = original;
    server.close();
  }
});
