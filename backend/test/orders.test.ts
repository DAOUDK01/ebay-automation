/** Orders + shipping modules: real MongoDB (in-memory) + real Express app, fake eBay clients. */
process.env.JWT_SECRET = "test-secret";
process.env.ENCRYPTION_KEY = "test-key";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { encrypt } from "../src/lib/crypto";
import { USER_SCOPES } from "../src/lib/ebay/auth";
import { SellClient } from "../src/lib/ebay/sell";
import { Listing } from "../src/models/Listing";
import { Proposal } from "../src/models/Proposal";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import { SyncState } from "../src/models/SyncState";
import { MODULES } from "../src/modules";
import { buildRefundPayload, buildTrackingPayload, carrierCode, deriveStatus, normalizeOrder, parseTrackingCsv } from "../src/modules/orders/ebay";
import { Order } from "../src/modules/orders/model";
import { orderCounts, setClientsFactory, startOfToday } from "../src/modules/orders/service";
import { countsFor, runAccountSync } from "../src/services/accountSync";

let mongo: MongoMemoryServer;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let cookie = "";
let userId = "";

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const reg = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `o${Date.now()}@x.test`, password: "password-123", name: "O" }),
  });
  cookie = reg.headers.get("set-cookie")!.split(";")[0];
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  userId = me.user.id ?? me.user._id;
});
after(async () => {
  setClientsFactory(null);
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

const makeStore = () =>
  Store.create({
    userId,
    ebayUserId: `seller${Math.random()}`,
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: USER_SCOPES },
    settings: { ...structuredClone(DEFAULT_SETTINGS), activeHours: { ...DEFAULT_SETTINGS.activeHours, timezone: "UTC" } },
  }) as Promise<StoreDocument>;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** A Fulfillment API order */
function ebayOrder(id: string, o: { pay?: string; ful?: string; cancel?: string; total?: number; created?: string; modified?: string; hrefs?: boolean; shipBy?: string } = {}) {
  const total = o.total ?? 50;
  return {
    orderId: id,
    legacyOrderId: `L-${id}`,
    creationDate: o.created ?? iso(3600_000),
    lastModifiedDate: o.modified ?? iso(1800_000),
    orderPaymentStatus: o.pay ?? "PAID",
    orderFulfillmentStatus: o.ful ?? "NOT_STARTED",
    cancelStatus: { cancelState: o.cancel ?? "NONE_REQUESTED" },
    buyer: { username: `buyer_${id}` },
    pricingSummary: {
      priceSubtotal: { value: String(total - 10), currency: "USD" },
      deliveryCost: { value: "10.00", currency: "USD" },
      total: { value: String(total), currency: "USD" },
    },
    totalMarketplaceFee: { value: "6.50", currency: "USD" },
    fulfillmentHrefs: o.hrefs ? [`https://api.ebay.com/sell/fulfillment/v1/order/${id}/shipping_fulfillment/F1`] : [],
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shippingServiceCode: "USPSPriority",
          shipTo: {
            fullName: "Pat Buyer",
            contactAddress: { addressLine1: "1 Main St", city: "Austin", stateOrProvince: "TX", postalCode: "78701", countryCode: "US" },
            primaryPhone: { phoneNumber: "5125550100" },
          },
        },
      },
    ],
    lineItems: [
      {
        lineItemId: `${id}-1`,
        legacyItemId: "111",
        title: "Brake Pad Set",
        sku: "BP-1",
        quantity: 2,
        lineItemCost: { value: String(total - 10), currency: "USD" },
        total: { value: String(total - 10), currency: "USD" },
        lineItemFulfillmentStatus: o.ful === "FULFILLED" ? "FULFILLED" : "NOT_STARTED",
        lineItemFulfillmentInstructions: { shipByDate: o.shipBy ?? iso(-86400_000) },
      },
    ],
  };
}

/** Fake eBay: getOrders pages, getOrder, shipping_fulfillment, issue_refund. Records calls. */
function fakeEbay(orders: any[]) {
  const calls: { method: string; path: string; query?: any; body?: any }[] = [];
  const sell = new SellClient(async () => "t");
  sell.get = (async (path: string, query?: any) => {
    calls.push({ method: "GET", path, query });
    if (path === "/sell/fulfillment/v1/order") {
      const off = Number(query.offset);
      const lim = Number(query.limit);
      return { total: orders.length, limit: lim, offset: off, orders: orders.slice(off, off + lim) };
    }
    const fm = path.match(/order\/([^/]+)\/shipping_fulfillment$/);
    if (fm) return { fulfillments: [{ fulfillmentId: "F1", shipmentTrackingNumber: "1Z999", shippingCarrierCode: "UPS", shippedDate: iso(0), lineItems: [{ lineItemId: `${fm[1]}-1`, quantity: 2 }] }] };
    const m = path.match(/order\/([^/]+)$/);
    if (m) return orders.find((o) => o.orderId === decodeURIComponent(m[1]));
    throw new Error(`unexpected GET ${path}`);
  }) as any;
  sell.post = (async (path: string, body?: any) => {
    calls.push({ method: "POST", path, body });
    if (path.endsWith("/issue_refund")) return { refundId: "R-1", refundStatus: "PENDING" };
    return null;
  }) as any;
  const revised: { itemId: string; changes: any }[] = [];
  const trading = {
    getItem: async (itemId: string) => ({ itemId, site: "eBayMotors", shipping: { policyId: "P10", policy: "Ground 10 KG" } }),
    reviseItem: async (itemId: string, changes: any) => {
      revised.push({ itemId, changes });
      return [];
    },
    getShippingPolicies: async () => [
      { id: "P3", name: "Ground 3 KG" },
      { id: "P5", name: "Ground 5 KG" },
      { id: "P10", name: "Ground 10 KG" },
    ],
  };
  const clients = { sell, trading, postOrder: {} } as any;
  setClientsFactory(() => clients);
  return { calls, clients, revised };
}

async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

beforeEach(() => setClientsFactory(null));

test("normalize: statuses, address, totals, fees", () => {
  assert.equal(deriveStatus({ orderPaymentStatus: "PAID", orderFulfillmentStatus: "NOT_STARTED" }), "awaiting_shipment");
  assert.equal(deriveStatus({ orderPaymentStatus: "PAID", orderFulfillmentStatus: "IN_PROGRESS" }), "awaiting_shipment");
  assert.equal(deriveStatus({ orderPaymentStatus: "PAID", orderFulfillmentStatus: "FULFILLED" }), "shipped");
  assert.equal(deriveStatus({ orderPaymentStatus: "PAID", cancelStatus: { cancelState: "CANCELED" } }), "cancelled");
  assert.equal(deriveStatus({ orderPaymentStatus: "FULLY_REFUNDED", orderFulfillmentStatus: "NOT_STARTED" }), "refunded");
  assert.equal(deriveStatus({ orderPaymentStatus: "PENDING" }), "awaiting_payment");
  const n = normalizeOrder(ebayOrder("A", { total: 60 }), { "111": "img.png" });
  assert.equal(n.shipTo.city, "Austin");
  assert.equal(n.totals.total, 60);
  assert.equal(n.totals.shipping, 10);
  assert.equal(n.fees, 6.5);
  assert.equal(n.lineItems[0].price, 25);
  assert.equal(n.lineItems[0].image, "img.png");
  assert.equal(n.shippingService, "USPSPriority");
  assert.ok(n.shipByDate instanceof Date);
});

test("sync: pages through getOrders, upserts, keeps the newest lastModifiedDate as cursor", async () => {
  const store = await makeStore();
  await Listing.create({ storeId: store._id, itemId: "111", title: "Brake Pad Set", imageUrl: "pads.png" });
  const orders = Array.from({ length: 5 }, (_, i) => ebayOrder(`O${i}`, { modified: iso((10 - i) * 60_000), hrefs: i === 4, ful: i === 4 ? "FULFILLED" : undefined }));
  const fake = fakeEbay(orders);
  // small pages to exercise paging
  const realPaged = fake.clients.sell.paged.bind(fake.clients.sell);
  fake.clients.sell.paged = (path: string, key: string, q: any) => realPaged(path, key, q, 2);

  const ordersModule = MODULES.find((m) => m.key === "orders")!;
  const runs = await runAccountSync(store, ["orders"], fake.clients, [ordersModule]);
  assert.deepEqual(runs.map((r) => [r.module, r.ok, r.summary]), [["orders", true, "5 orders updated"]]);
  const listCalls = fake.calls.filter((c) => c.path === "/sell/fulfillment/v1/order");
  assert.equal(listCalls.length, 3, "3 pages of 2");
  const first = listCalls[0].query.filter as string;
  const since = new Date(first.match(/\[(.*)\.\.\]/)![1]).getTime();
  assert.ok(Math.abs(since - (Date.now() - 90 * 86400_000)) < 60_000, "first run looks back 90 days");

  const st = await SyncState.findOne({ storeId: store._id, module: "orders" }).lean();
  assert.equal(st!.cursor, orders[4].lastModifiedDate);
  assert.equal(await Order.countDocuments({ storeId: store._id }), 5);
  const shipped = await Order.findOne({ storeId: store._id, orderId: "O4" }).lean();
  assert.equal(shipped!.status, "shipped");
  assert.equal(shipped!.fulfillments[0].trackingNumber, "1Z999");
  assert.equal((await Order.findOne({ orderId: "O0" }).lean())!.lineItems[0].image, "pads.png");

  // second run starts from the cursor; one order changed since
  fake.calls.length = 0;
  orders[1] = { ...orders[1], lastModifiedDate: iso(0), orderFulfillmentStatus: "FULFILLED" };
  const runs2 = await runAccountSync(store, ["orders"], fake.clients, [ordersModule]);
  assert.equal(fake.calls[0].query.filter, `lastmodifieddate:[${orders[4].lastModifiedDate}..]`);
  assert.equal(runs2[0].summary, "1 order updated");
  assert.equal((await Order.findOne({ orderId: "O1" }).lean())!.status, "shipped");
  assert.equal((await SyncState.findOne({ storeId: store._id, module: "orders" }).lean())!.cursor, orders[1].lastModifiedDate);
});

test("counts: awaiting shipment, orders and sales today", async () => {
  const store = await makeStore();
  const n = (o: any) => ({ storeId: store._id, ...normalizeOrder(o) });
  await Order.insertMany([
    n(ebayOrder("T1", { total: 40, created: iso(60_000) })),
    n(ebayOrder("T2", { total: 25.5, created: iso(60_000), ful: "FULFILLED" })),
    n(ebayOrder("T3", { total: 99, created: iso(60_000), cancel: "CANCELED" })),
    n(ebayOrder("Y1", { total: 70, created: iso(3 * 86400_000) })),
  ]);
  const c = await orderCounts(store);
  // T1 + Y1 awaiting; T1 + T2 today (cancelled excluded) - unless the test runs in the first minute after UTC midnight
  assert.equal(c.awaitingShipment, 2);
  if (Date.now() - startOfToday("UTC").getTime() > 120_000) {
    assert.equal(c.ordersToday, 2);
    assert.equal(c.salesToday, 65.5);
  }
  assert.equal(c.currency, "USD");
  // merged into the sidebar counts with the shipping module's badge
  const merged = await countsFor(store, MODULES.filter((m) => m.key === "orders" || m.key === "shipping"));
  assert.equal(merged.awaitingShipment, 2);
});

test("startOfToday: midnight in the store's time zone", () => {
  const now = new Date("2026-11-20T03:30:00Z"); // 22:30 on the 19th in New York (UTC-5)
  assert.equal(startOfToday("America/New_York", now).toISOString(), "2026-11-19T05:00:00.000Z");
  assert.equal(startOfToday("UTC", now).toISOString(), "2026-11-20T00:00:00.000Z");
});

test("tracking payload: defaults to unshipped lines, normalizes carrier and number", () => {
  const order = { lineItems: [{ lineItemId: "L1", qty: 2 }, { lineItemId: "L2", qty: 1, fulfillmentStatus: "FULFILLED" }] };
  const p = buildTrackingPayload(order, { carrier: "fedex", trackingNumber: " 7712 3456 7890 ", shippedDate: "2026-11-19T10:00:00Z" });
  assert.deepEqual(p, {
    lineItems: [{ lineItemId: "L1", quantity: 2 }],
    shippedDate: "2026-11-19T10:00:00.000Z",
    shippingCarrierCode: "FedEx",
    trackingNumber: "771234567890",
  });
  assert.throws(() => buildTrackingPayload(order, { carrier: "UPS", trackingNumber: "x" }), /6-40/);
  assert.throws(() => buildTrackingPayload(order, { carrier: "UPS", trackingNumber: "1Z12345678", lineItems: [{ lineItemId: "NOPE", quantity: 1 }] }), /not in this order/);
  assert.equal(carrierCode("Canada Post"), "CanadaPost");
  assert.equal(carrierCode("Some Courier"), "Some Courier");
});

test("refund payload: full = what's left, partial capped", () => {
  const order = { totals: { total: 80, currency: "USD" }, refunds: [{ amount: 20, status: "REFUNDED" }, { amount: 5, status: "FAILED" }] };
  assert.deepEqual(buildRefundPayload(order, { kind: "full", reason: "BUYER_CANCEL" }), {
    reasonForRefund: "BUYER_CANCEL",
    orderLevelRefundAmount: { value: "60.00", currency: "USD" },
  });
  assert.deepEqual(buildRefundPayload(order, { kind: "partial", amount: 12.345, reason: "OTHER", comment: " scratched " }), {
    reasonForRefund: "OTHER",
    comment: "scratched",
    orderLevelRefundAmount: { value: "12.35", currency: "USD" },
  });
  assert.throws(() => buildRefundPayload(order, { kind: "partial", amount: 61, reason: "OTHER" }), /more than 60.00/);
  assert.throws(() => buildRefundPayload({ ...order, refunds: [{ amount: 80 }] }, { kind: "full", reason: "OTHER" }), /fully refunded/);
});

test("CSV parser: header in any order, separators, quotes, bad lines", () => {
  const a = parseTrackingCsv("Tracking Number,Order ID,Carrier\n1Z999AA10123456784,12-34567-89012,UPS\r\n\n\"9400 1000\",\"99-1\",usps\nonly-one-col\n");
  assert.deepEqual(a.rows, [
    { line: 2, orderId: "12-34567-89012", carrier: "UPS", trackingNumber: "1Z999AA10123456784" },
    { line: 4, orderId: "99-1", carrier: "usps", trackingNumber: "94001000" },
  ]);
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /Line 5/);
  const b = parseTrackingCsv("A1;DHL;JD0123456789\nA2;UPS;1Z2");
  assert.deepEqual(b.rows.map((r) => r.orderId), ["A1", "A2"]);
  const c = parseTrackingCsv("A1\tFedEx\t771234567890");
  assert.equal(c.rows[0].carrier, "FedEx");
  assert.match(parseTrackingCsv("order,tracking\nA,1").errors[0], /Header/);
});

test("API: list/filter/search, tracking + refund send the right eBay calls, bulk CSV", async () => {
  const store = await makeStore();
  const src = [ebayOrder("A-1", { total: 50 }), ebayOrder("B-2", { total: 30, ful: "FULFILLED" }), ebayOrder("C-3", { cancel: "CANCELED" }), ebayOrder("D-4", { total: 20 })];
  await Order.insertMany(src.map((o) => ({ storeId: store._id, ...normalizeOrder(o) })));
  const fake = fakeEbay(src);
  const S = `/stores/${store._id}/orders`;

  const list = await call(`${S}?status=awaiting`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.items.map((o: any) => o.orderId).sort(), ["A-1", "D-4"]);
  assert.equal(list.data.items[0].raw, undefined, "raw JSON not sent in lists");
  assert.deepEqual(list.data.tabs, { awaiting: 2, shipped: 1, cancelled: 1, unpaid: 0, all: 4 });
  assert.equal((await call(`${S}?q=buyer_B`)).data.items[0].orderId, "B-2");
  assert.equal((await call(`${S}/A-1`)).data.refundable, 50);
  assert.equal((await call(`${S}/nope`)).status, 404);

  // tracking
  const t = await call(`${S}/A-1/tracking`, "POST", { carrier: "ups", trackingNumber: "1z 999 aa1 0123456784", shippedDate: "2026-11-19T12:00:00Z" });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const post = fake.calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/sell/fulfillment/v1/order/A-1/shipping_fulfillment");
  assert.deepEqual(post.body, {
    lineItems: [{ lineItemId: "A-1-1", quantity: 2 }],
    shippedDate: "2026-11-19T12:00:00.000Z",
    shippingCarrierCode: "UPS",
    trackingNumber: "1Z999AA10123456784",
  });
  assert.ok(fake.calls.some((c) => c.method === "GET" && c.path === "/sell/fulfillment/v1/order/A-1"), "order refreshed afterwards");
  assert.equal((await call(`${S}/C-3/tracking`, "POST", { carrier: "UPS", trackingNumber: "1Z12345678" })).status, 400, "cancelled");

  // refund
  fake.calls.length = 0;
  const bad = await call(`${S}/A-1/refund`, "POST", { kind: "partial", amount: 500, reason: "OTHER" });
  assert.equal(bad.status, 400);
  assert.equal(fake.calls.length, 0, "nothing sent when the amount is invalid");
  const r = await call(`${S}/A-1/refund`, "POST", { kind: "partial", amount: 7.5, reason: "SELLER_WRONG_ITEM", comment: "wrong colour" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rp = fake.calls.find((c) => c.method === "POST")!;
  assert.equal(rp.path, "/sell/fulfillment/v1/order/A-1/issue_refund");
  assert.deepEqual(rp.body, { reasonForRefund: "SELLER_WRONG_ITEM", comment: "wrong colour", orderLevelRefundAmount: { value: "7.50", currency: "USD" } });
  assert.equal(r.data.order.refunds[0].refundId, "R-1");
  assert.equal((await call(`${S}/A-1`)).data.refundable, 42.5);

  // bulk CSV: dry run sends nothing, then the upload
  fake.calls.length = 0;
  const csv = "order id,carrier,tracking\nD-4,USPS,9400111899223344556677\nC-3,UPS,1Z0000000001\nZZZ,UPS,1Z0000000002\nbroken";
  const dry = await call(`${S}/bulk-tracking`, "POST", { csv, dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.data.rows.map((x: any) => [x.input, x.ok]), [["D-4", true], ["C-3", false], ["ZZZ", false]]);
  assert.equal(dry.data.errors.length, 1);
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0);
  const up = await call(`${S}/bulk-tracking`, "POST", { csv });
  assert.equal(up.data.uploaded, 1);
  const posts = fake.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.trackingNumber, "9400111899223344556677");

  // packing slips: several orders in the requested order
  const slips = await call(`${S}/batch?ids=D-4,A-1`);
  assert.deepEqual(slips.data.orders.map((o: any) => o.orderId), ["D-4", "A-1"]);
});

test("shipping: queue by ship-by date, policy fixes listed and applied one listing at a time", async () => {
  const store = await makeStore();
  await Order.insertMany([
    { storeId: store._id, ...normalizeOrder(ebayOrder("late", { shipBy: iso(3600_000) })) },
    { storeId: store._id, ...normalizeOrder(ebayOrder("later", { shipBy: iso(-3 * 86400_000) })) },
    { storeId: store._id, ...normalizeOrder(ebayOrder("done", { ful: "FULFILLED" })) },
  ]);
  const fake = fakeEbay([]);
  const S = `/stores/${store._id}/shipping`;
  const q = await call(`${S}/queue`);
  assert.deepEqual(q.data.items.map((o: any) => [o.orderId, o.overdue]), [["late", true], ["later", false]]);
  assert.equal(q.data.overdue, 1);

  await Listing.insertMany([
    { storeId: store._id, itemId: "900", title: "Front Bumper Cover", active: true },
    { storeId: store._id, itemId: "901", title: "Brake Caliper", active: true },
    { storeId: store._id, itemId: "902", title: "Old listing", active: false },
  ]);
  const analysis = (current: any, suggested: any, matches: boolean) => ({
    source: "listing", actualKg: 4, dimensionalKg: 4.5, divisor: 5000, billableKg: 4.5, categoryKg: 5, overMax: false,
    package: { weightKg: 4, lengthCm: 30, widthCm: 30, heightCm: 25 }, current, suggested, matches, note: "x",
  });
  const P10 = { id: "P10", name: "Ground 10 KG", kg: 10 };
  const P5 = { id: "P5", name: "Ground 5 KG", kg: 5 };
  await Proposal.insertMany([
    // 900: older analysis said fine, newest says wrong -> listed
    { storeId: store._id, itemId: "900", status: "no_change", shipping: analysis(P5, P5, true), createdAt: new Date(Date.now() - 86400_000) },
    { storeId: store._id, itemId: "900", status: "no_change", shipping: analysis(P10, P5, false) },
    // 901: already pushed with the suggested policy -> not listed
    { storeId: store._id, itemId: "901", status: "pushed", changes: { shippingPolicyId: "P5" }, shipping: analysis(P10, P5, false) },
    // 902: inactive listing -> not listed
    { storeId: store._id, itemId: "902", status: "no_change", shipping: analysis(P10, P5, false) },
  ]);
  const fixes = await call(`${S}/policy-fixes`);
  assert.deepEqual(fixes.data.items.map((f: any) => [f.itemId, f.current.id, f.suggested.id]), [["900", "P10", "P5"]]);

  // live re-check uses analyzeShipping with the store's current policies (same answer here)
  const live = await call(`${S}/policy-fixes?live=1`);
  assert.equal(live.data.live, true);
  assert.equal(live.data.items[0].suggested.id, "P5");

  assert.equal((await call(`${S}/policy-fixes/900/apply`, "POST", { policyId: "P3" })).status, 409, "must match the suggestion");
  assert.equal(fake.revised.length, 0);
  const ap = await call(`${S}/policy-fixes/900/apply`, "POST", { policyId: "P5" });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.deepEqual(fake.revised, [{ itemId: "900", changes: { shippingPolicyId: "P5" } }]);
  const rec = await Proposal.findOne({ storeId: store._id, itemId: "900", kind: "manual" }).lean();
  assert.equal(rec!.status, "pushed");
  assert.equal((rec!.before as any).shipping.policyId, "P10", "snapshot kept for revert");
  assert.equal((await call(`${S}/policy-fixes`)).data.items.length, 0, "fixed listing drops off");
});
