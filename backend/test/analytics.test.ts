/** Analytics module: traffic report parsing, standards, sync snapshots, counts, API. */
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
import analytics from "../src/modules/analytics";
import { currentSellerLevel, mapStandardsProfiles, parseTrafficReport, trafficQuery, trafficWindow } from "../src/modules/analytics/logic";
import { AccountHealth, ListingTraffic, TrafficDay } from "../src/modules/analytics/models";
import { syncAnalytics } from "../src/modules/analytics/sync";
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

/** eBay returns metrics in header order (not necessarily ours). */
const report = (rows: [string, number, number, number][]) => ({
  header: {
    dimensionKeys: [{ key: "DAY" }],
    metrics: [{ key: "LISTING_VIEWS_TOTAL" }, { key: "TRANSACTION" }, { key: "LISTING_IMPRESSION_TOTAL" }, { key: "CLICK_THROUGH_RATE" }, { key: "SALES_CONVERSION_RATE" }],
  },
  records: rows.map(([key, views, sales, imps]) => ({
    dimensionValues: [{ value: key }],
    metricValues: [{ value: views }, { value: sales }, { value: imps }, { value: "1.5" }, { value: 0, applicable: false }],
  })),
});

const STANDARDS = {
  standardsProfiles: [
    { program: "PROGRAM_US", standardsLevel: "ABOVE_STANDARD", defaultProgram: true, cycle: { cycleType: "PROJECTED" }, metrics: [] },
    {
      program: "PROGRAM_US",
      standardsLevel: "TOP_RATED",
      defaultProgram: true,
      cycle: { cycleType: "CURRENT", evaluationDate: "2026-11-20T00:00:00Z" },
      metrics: [
        { metricKey: "DEFECTIVE_TRANSACTION_RATE", name: "Transaction defect rate", value: { value: "0.31" }, level: "TOP_RATED", thresholdUpperBound: { value: "0.5" }, numerator: 2, denominator: 640 },
        { metricKey: "SHIPPING_MISS_RATE", value: 1.2, level: "TOP_RATED" },
      ],
    },
    { program: "PROGRAM_GLOBAL", standardsLevel: "BELOW_STANDARD", defaultProgram: false, cycle: { cycleType: "CURRENT" }, metrics: [] },
  ],
};

test("traffic report: metrics read by header key, not position; not-applicable = null", () => {
  const rows = parseTrafficReport(report([["20261101", 40, 2, 900]]));
  assert.deepEqual(rows, [{ key: "20261101", impressions: 900, views: 40, ctr: 1.5, conversion: null, transactions: 2 }]);
  assert.deepEqual(parseTrafficReport({}), []);
});

test("traffic query: last 30 complete days, eBay filter syntax", () => {
  const { start, end } = trafficWindow(30, new Date("2026-11-20T15:00:00Z"));
  assert.equal(end.toISOString().slice(0, 10), "2026-11-19");
  assert.equal(start.toISOString().slice(0, 10), "2026-10-21");
  const q = trafficQuery("LISTING", "EBAY_US", start, end);
  assert.equal(q.filter, "marketplace_ids:{EBAY_US},date_range:[20261021..20261119]");
  assert.equal(q.metric, "LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,CLICK_THROUGH_RATE,SALES_CONVERSION_RATE,TRANSACTION");
  assert.equal(q.sort, "-LISTING_IMPRESSION_TOTAL");
  assert.equal("sort" in trafficQuery("DAY", "EBAY_US", start, end), false);
});

test("seller standards: values unwrapped, level from the default program's current cycle", () => {
  const p = mapStandardsProfiles(STANDARDS);
  assert.equal(currentSellerLevel(p), "TOP_RATED");
  const dtr = p[1].metrics[0];
  assert.equal(dtr.value, 0.31);
  assert.equal(dtr.thresholdUpper, 0.5);
  assert.equal(dtr.denominator, 640);
  assert.equal(p[1].metrics[1].value, 1.2);
  assert.equal(currentSellerLevel([]), null);
});

function fakeSell(listingRows: [string, number, number, number][]) {
  const calls: { path: string; query: any }[] = [];
  return {
    calls,
    get: async (path: string, query: any = {}) => {
      calls.push({ path, query });
      if (path.endsWith("traffic_report")) {
        return query.dimension === "DAY" ? report([["20261118", 30, 1, 500], ["20261119", 50, 3, 800]]) : report(listingRows);
      }
      if (path.endsWith("seller_standards_profile")) return STANDARDS;
      if (path.includes("ITEM_NOT_RECEIVED")) throw new Error("eBay API 404: not evaluated");
      if (path.includes("customer_service_metric"))
        return { dimensionMetrics: [{ dimension: { name: "eBay Motors > Parts" }, metrics: [{ value: "0.8", benchmark: { rating: "AVERAGE" } }] }] };
      throw new Error(`unexpected ${path}`);
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

test("sync: daily + listing snapshots (old listings dropped), health, missing service metrics tolerated, counts", async () => {
  const store = await makeStore();
  await ListingTraffic.create({ storeId: store._id, itemId: "OLD", views: 99 });
  const sell = fakeSell([["111", 120, 0, 3000], ["222", 80, 4, 2000]]);
  const r = await syncAnalytics(ctxFor(store, sell), new Date("2026-11-20T15:00:00Z"));
  assert.deepEqual(r.cursor, { lastDay: "2026-11-19" });
  assert.match(r.summary!, /2 days, 2 listings, top rated/);
  // 180 days of daily traffic in two 90-day calls (enough to compare a 90-day range with the one before)
  assert.deepEqual(
    sell.calls.filter((c) => c.query.dimension === "DAY").map((c) => c.query.filter),
    ["marketplace_ids:{EBAY_US},date_range:[20260524..20260821]", "marketplace_ids:{EBAY_US},date_range:[20260822..20261119]"],
  );
  assert.equal(sell.calls.find((c) => c.query.dimension === "LISTING")?.query.filter, "marketplace_ids:{EBAY_US},date_range:[20261021..20261119]");

  const days = await TrafficDay.find({ storeId: store._id }).sort({ day: 1 }).lean();
  assert.deepEqual(days.map((d) => [d.day, d.views, d.transactions]), [["2026-11-18", 30, 1], ["2026-11-19", 50, 3]]);
  const listings = await ListingTraffic.find({ storeId: store._id }).sort({ itemId: 1 }).lean();
  assert.deepEqual(listings.map((l) => l.itemId), ["111", "222"]);
  assert.equal(listings[0].periodEnd, "2026-11-19");

  const h = await AccountHealth.findOne({ storeId: store._id }).lean();
  assert.equal(h?.sellerLevel, "TOP_RATED");
  assert.equal(h?.customerService.length, 1);
  assert.equal(h?.customerService[0].rating, "AVERAGE");

  // re-sync is idempotent
  await syncAnalytics(ctxFor(store, sell), new Date("2026-11-20T15:00:00Z"));
  assert.equal(await TrafficDay.countDocuments({ storeId: store._id }), 2);

  assert.deepEqual(await analytics.counts!(store), { sellerLevel: "TOP_RATED" });
  assert.deepEqual(await analytics.counts!(await makeStore()), { sellerLevel: null });
});

test("API: overview fills 30 days, listings joined, views-but-no-sales list", async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const reg = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `a${Date.now()}@x.test`, password: "password-123", name: "A" }),
    });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
    const store = await makeStore(me.user.id ?? me.user._id);
    await syncAnalytics(ctxFor(store, fakeSell([["111", 120, 0, 3000], ["222", 80, 4, 2000], ["333", 3, 0, 50]])));
    await Listing.create({ storeId: store._id, itemId: "111", title: "Lots of views", price: 20 });

    const ov = await (await fetch(`${base}/stores/${store._id}/analytics/overview`, { headers: { cookie } })).json();
    assert.equal(ov.days.length, 30);
    assert.equal(ov.health.sellerLevel, "TOP_RATED");
    assert.ok(ov.thresholds.DEFECTIVE_TRANSACTION_RATE);

    const ls = await (await fetch(`${base}/stores/${store._id}/analytics/listings?sort=sales`, { headers: { cookie } })).json();
    assert.equal(ls.top[0].itemId, "222");
    assert.deepEqual(ls.noSales.map((l: any) => l.itemId), ["111"], "few views = not flagged");
    assert.equal(ls.noSales[0].title, "Lots of views");
    assert.equal(ls.noSales[0].ctr, 4);
  } finally {
    server.close();
  }
});

test("sales report: revenue, orders, AOV, units, refunds, best sellers, weekday, vs previous period", async () => {
  const { salesReport, change, toRange } = await import("../src/modules/analytics/sales");
  const now = new Date("2026-11-20T15:00:00Z");
  const o = (id: string, daysAgo: number, total: number, extra: any = {}) => ({
    orderId: id,
    status: "shipped",
    creationDate: new Date(now.getTime() - daysAgo * 86_400_000),
    totals: { total, currency: "USD" },
    lineItems: [{ itemId: extra.itemId ?? "111", title: extra.title ?? "Headlight", qty: extra.qty ?? 1, total }],
    refunds: extra.refunds ?? [],
    ...extra,
  });
  const r = salesReport(
    [
      o("A", 0, 100),
      o("B", 2, 50, { itemId: "222", title: "Mirror", qty: 2 }),
      o("C", 3, 80, { status: "cancelled" }),
      o("D", 5, 30, { refunds: [{ amount: 30 }], status: "refunded" }),
      o("P1", 9, 60), // previous 7-day period
      o("OLD", 40, 999), // outside both
    ],
    7,
    now,
  );
  assert.equal(r.days.length, 7);
  assert.deepEqual(
    { orders: r.totals.orders, revenue: r.totals.revenue, units: r.totals.units, aov: r.totals.avgOrderValue, cancelled: r.totals.cancelled, refunded: r.totals.refunded },
    { orders: 3, revenue: 180, units: 4, aov: 60, cancelled: 1, refunded: 1 },
  );
  assert.equal(r.previous.revenue, 60);
  assert.equal(r.change.revenue, 200);
  assert.deepEqual(r.topItems.map((i) => i.itemId), ["111", "222"]);
  assert.equal(r.days.at(-1)!.revenue, 100, "today included");
  assert.equal(r.weekday.reduce((s, w) => s + w.orders, 0), 3);
  assert.equal(change(5, 0), null);
  assert.equal(change(0, 0), 0);
  assert.equal(toRange("90"), 90);
  assert.equal(toRange("365"), 30, "unknown ranges fall back to 30 days");
});
