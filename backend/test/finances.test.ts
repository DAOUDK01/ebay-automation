/** Finances module: mapping, profit per order, P&L, CSV, incremental sync with cursors, counts, API. */
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
import finances from "../src/modules/finances";
import { computeOrderProfits, mapTransaction, monthlyPnl, transactionsCsv, type ListingCost } from "../src/modules/finances/logic";
import { FinTransaction, FundsSummary, Payout } from "../src/modules/finances/models";
import { syncFinances, TX_OVERLAP_DAYS } from "../src/modules/finances/sync";
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

const makeStore = (extra: Record<string, unknown> = {}, userId = new mongoose.Types.ObjectId()) =>
  Store.create({
    userId,
    ebayUserId: `seller${Math.random()}`,
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: USER_SCOPES },
    settings: structuredClone(DEFAULT_SETTINGS),
    ...extra,
  }) as Promise<StoreDocument>;

const money = (value: number, currency = "USD") => ({ value: value.toFixed(2), currency });

/** eBay-shaped SALE: net 82.10 after 12.90 fees (FVF 12.60 + 0.30 per order) */
const SALE = {
  transactionId: "T-SALE-1",
  transactionType: "SALE",
  transactionStatus: "PAYOUT",
  transactionDate: "2026-10-05T10:00:00.000Z",
  bookingEntry: "CREDIT",
  amount: money(82.1),
  totalFeeAmount: money(12.9),
  totalFeeBasisAmount: money(101.5),
  orderId: "11-111-111",
  payoutId: "P-1",
  buyer: { username: "buyer1" },
  orderLineItems: [
    {
      lineItemId: "L1",
      feeBasisAmount: money(101.5),
      marketplaceFees: [
        { feeType: "FINAL_VALUE_FEE", amount: money(12.6) },
        { feeType: "FINAL_VALUE_FEE_FIXED_PER_ORDER", amount: money(0.3) },
      ],
    },
  ],
  references: [{ referenceId: "256100000001", referenceType: "ITEM_ID" }],
};

test("mapTransaction: signed amounts, fee breakdown, order and item ids", () => {
  const s = mapTransaction(SALE);
  assert.equal(s.amount, 82.1);
  assert.equal(s.feeTotal, 12.9);
  assert.equal(s.orderId, "11-111-111");
  assert.equal(s.lines[0].itemId, "256100000001", "single line takes the ITEM_ID reference");
  assert.equal(s.lines[0].quantity, 1);
  assert.equal(s.buyer, "buyer1");

  const label = mapTransaction({
    transactionId: "T-L",
    transactionType: "SHIPPING_LABEL",
    transactionDate: "2026-10-05T12:00:00Z",
    bookingEntry: "DEBIT",
    amount: money(8.45),
    references: [{ referenceId: "11-111-111", referenceType: "ORDER_ID" }],
  });
  assert.equal(label.amount, -8.45, "debits are negative");
  assert.equal(label.orderId, "11-111-111", "order id from references");
  assert.equal(label.feeTotal, 0);
});

test("profit per order: sale - fees - label - refunds - cost x qty; missing cost flagged", () => {
  const costs = new Map<string, ListingCost>([
    ["A", { cost: 20, title: "Brake pads" }],
    ["B", { cost: null, title: "Rotor" }],
  ]);
  const d = "2026-10-05T10:00:00Z";
  const txs = [
    // order 1: 2 x A
    { type: "SALE", date: d, amount: 80, feeTotal: 12, orderId: "O1", lines: [{ itemId: "A", quantity: 2 }] },
    { type: "SHIPPING_LABEL", date: d, amount: -8.5, feeTotal: 0, orderId: "O1" },
    { type: "NON_SALE_CHARGE", date: d, amount: -4, feeTotal: 0, orderId: "O1" }, // ad fee
    { type: "REFUND", date: d, amount: -10, feeTotal: 0, orderId: "O1" },
    // order 2: B has no cost
    { type: "SALE", date: "2026-10-06T10:00:00Z", amount: 45, feeTotal: 5, orderId: "O2", lines: [{ itemId: "B", quantity: 1 }] },
    // a label with no sale in range isn't an order
    { type: "SHIPPING_LABEL", date: d, amount: -7, feeTotal: 0, orderId: "O3" },
    // unrelated: no order id
    { type: "TRANSFER", date: d, amount: -100, feeTotal: 0 },
  ];
  const out = computeOrderProfits(txs, costs);
  assert.deepEqual(out.map((o) => o.orderId), ["O2", "O1"], "newest first, label-only order skipped");
  const o1 = out.find((o) => o.orderId === "O1")!;
  assert.equal(o1.saleTotal, 92);
  assert.equal(o1.fees, 16);
  assert.equal(o1.shippingLabels, 8.5);
  assert.equal(o1.refunds, 10);
  assert.equal(o1.itemCost, 40);
  assert.equal(o1.profit, 92 - 16 - 8.5 - 10 - 40);
  assert.equal(o1.missingCost, false);
  assert.equal(o1.items[0].title, "Brake pads");
  const o2 = out.find((o) => o.orderId === "O2")!;
  assert.equal(o2.missingCost, true);
  assert.equal(o2.itemCost, 0);
  assert.equal(o2.profit, 45);

  // a sale whose item isn't known at all
  const [o4] = computeOrderProfits([{ type: "SALE", date: d, amount: 10, feeTotal: 1, orderId: "O4" }], costs);
  assert.equal(o4.missingCost, true);

  const pnl = monthlyPnl(txs, out);
  assert.equal(pnl.length, 1);
  const m = pnl[0];
  assert.equal(m.month, "2026-10");
  assert.equal(m.sales, 92 + 50);
  assert.equal(m.fees, 12 + 4 + 5);
  assert.equal(m.shippingLabels, 15.5);
  assert.equal(m.refunds, 10);
  assert.equal(m.costOfGoods, 40);
  assert.equal(m.orders, 2);
  assert.equal(m.missingCostOrders, 1);
  assert.equal(m.net, 142 - 21 - 10 - 15.5 - 40, "transfers are left out");
});

test("CSV export quotes and neutralises formulas", () => {
  const csv = transactionsCsv([
    { date: new Date("2026-10-05T10:00:00Z"), type: "SALE", transactionId: "T1", amount: -8.45, feeTotal: 0, currency: "USD", buyer: "=HYPERLINK(1)", memo: 'a "b", c', itemIds: ["1", "2"] },
  ]);
  const [head, row] = csv.trim().split("\r\n");
  assert.match(head, /^date,type,status,transaction_id/);
  assert.ok(row.includes("'=HYPERLINK(1)"));
  assert.ok(row.includes('"a ""b"", c"'));
  assert.ok(row.includes(",-8.45,"));
  assert.ok(row.includes(",1 2,"));
});

/** Fake Finances API: records every call, serves canned pages. */
function fakeApi(data: { payouts: any[]; transactions: any[]; byPayout?: Record<string, any[]> }) {
  const calls: { path: string; query: any }[] = [];
  return {
    calls,
    async get(path: string, query?: any) {
      calls.push({ path, query });
      if (path.endsWith("seller_funds_summary"))
        return { totalFunds: money(500), availableFunds: money(320.55), processingFunds: money(150), fundsOnHold: money(29.45) };
      throw new Error(`unexpected GET ${path}`);
    },
    async *paged(path: string, _key: string, query: any = {}) {
      calls.push({ path, query });
      if (path.endsWith("/payout")) yield* data.payouts;
      else if (String(query.filter).startsWith("payoutId:")) yield* data.byPayout?.[/\{(.+)\}/.exec(query.filter)![1]] ?? [];
      else yield* data.transactions;
    },
  };
}

const ctxFor = (store: StoreDocument, cursor: any, sell: any = {}): SyncContext => ({
  store,
  clients: { sell, trading: {} as any, postOrder: {} as any },
  cursor,
  lastSuccessAt: null,
  log: () => {},
});

test("sync: funds, payouts, transactions, cursors with overlap, payout membership, item enrichment, counts", async () => {
  const store = await makeStore();
  const payout = { payoutId: "P-1", payoutStatus: "SUCCEEDED", payoutDate: "2026-10-08T00:00:00Z", amount: money(82.1), transactionCount: 2, payoutInstrument: { nickname: "Checking", accountLastFourDigits: "1234" } };
  const label = { transactionId: "T-L1", transactionType: "SHIPPING_LABEL", transactionDate: "2026-10-05T12:00:00Z", bookingEntry: "DEBIT", amount: money(8.45), orderId: "11-111-111" };
  const api = fakeApi({ payouts: [payout], transactions: [SALE, label], byPayout: { "P-1": [{ ...label, payoutId: "P-1" }] } });

  // the sale's order (Fulfillment API) gives the real quantity
  const sell = {
    get: async (path: string, q: any) => {
      assert.equal(path, "/sell/fulfillment/v1/order");
      assert.equal(q.orderIds, "11-111-111");
      return { orders: [{ orderId: "11-111-111", lineItems: [{ lineItemId: "L1", legacyItemId: "256100000001", quantity: 2, title: "Pads" }] }] };
    },
  };
  const r1 = await syncFinances(ctxFor(store, null, sell), api);
  const firstTx = api.calls.find((c) => c.path.endsWith("/transaction"))!;
  assert.match(firstTx.query.filter, /^transactionDate:\[\d{4}-\d\d-\d\dT[^,]*\.\.\]$/, "date filter only - every transaction type");
  assert.deepEqual(r1.cursor, { payoutDate: "2026-10-08T00:00:00.000Z", transactionDate: "2026-10-05T12:00:00.000Z" });
  assert.match(r1.summary!, /2 transactions, 1 payouts, 1 sales matched/);
  assert.ok(api.calls.some((c) => c.query?.filter === "payoutId:{P-1}"), "new payout -> its transactions are read");

  const funds = await FundsSummary.findOne({ storeId: store._id }).lean();
  assert.equal(funds?.availableFunds, 320.55);
  assert.equal(funds?.fundsOnHold, 29.45);
  assert.equal((await Payout.findOne({ storeId: store._id }).lean())?.instrument?.last4, "1234");
  const lab = await FinTransaction.findOne({ storeId: store._id, transactionId: "T-L1" }).lean();
  assert.equal(lab?.payoutId, "P-1");
  assert.equal(lab?.amount, -8.45);
  const sale = await FinTransaction.findOne({ storeId: store._id, type: "SALE" }).lean();
  assert.equal(sale?.enriched, true);
  assert.equal(sale?.lines[0].quantity, 2);

  // second run: from the cursor minus the overlap; payout unchanged -> not re-read; enrichment kept
  api.calls.length = 0;
  const r2 = await syncFinances(ctxFor(store, r1.cursor, { get: async () => assert.fail("nothing left to enrich") }), api);
  const tx2 = api.calls.find((c) => c.path.endsWith("/transaction"))!;
  const from = new Date(/\[(.+)\.\.\]/.exec(tx2.query.filter)![1]);
  assert.equal(from.toISOString(), new Date(Date.parse("2026-10-05T12:00:00Z") - TX_OVERLAP_DAYS * 86_400_000).toISOString());
  assert.ok(!api.calls.some((c) => String(c.query?.filter).startsWith("payoutId:")));
  assert.equal((await FinTransaction.findOne({ storeId: store._id, type: "SALE" }).lean())?.lines[0].quantity, 2, "re-sync keeps the order's quantity");
  assert.deepEqual(r2.cursor, r1.cursor);
  assert.equal(await FinTransaction.countDocuments({ storeId: store._id }), 2, "upserts, no duplicates");

  assert.deepEqual(await finances.counts!(store), { availableFunds: 320.55, currency: "USD" });
  assert.deepEqual(await finances.counts!(await makeStore()), { availableFunds: null });
});

test("sync: EU/UK accounts are skipped (eBay digital signatures not supported yet)", async () => {
  const store = await makeStore({ marketplaceId: "EBAY_GB" });
  const api = fakeApi({ payouts: [], transactions: [] });
  const r = await syncFinances(ctxFor(store, null), api);
  assert.match(r.summary!, /digital signatures/);
  assert.equal(api.calls.length, 0);
});

test("API: profit, missing-cost filter, P&L, transactions filters and CSV", async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const reg = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `f${Date.now()}@x.test`, password: "password-123", name: "F" }),
    });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
    const store = await makeStore({}, me.user.id ?? me.user._id);
    await Listing.create({ storeId: store._id, itemId: "256100000001", title: "Pads", cost: 20 });
    const now = new Date();
    await FinTransaction.insertMany([
      { storeId: store._id, ...mapTransaction({ ...SALE, transactionDate: now.toISOString() }) },
      { storeId: store._id, ...mapTransaction({ ...SALE, transactionId: "T-SALE-2", orderId: "22-2", transactionDate: now.toISOString(), references: [{ referenceId: "999", referenceType: "ITEM_ID" }] }) },
      { storeId: store._id, ...mapTransaction({ transactionId: "T-L", transactionType: "SHIPPING_LABEL", transactionDate: now.toISOString(), bookingEntry: "DEBIT", amount: money(8), orderId: "11-111-111" }) },
    ]);
    const get = async (p: string) => {
      const r = await fetch(`${base}/stores/${store._id}/finances${p}`, { headers: { cookie } });
      assert.equal(r.status, 200, p);
      return r;
    };
    const profit = await (await get("/profit")).json();
    assert.equal(profit.totals.orders, 2);
    assert.equal(profit.totals.missingCost, 1);
    const o1 = profit.items.find((o: any) => o.orderId === "11-111-111");
    assert.equal(o1.profit, Math.round((95 - 12.9 - 8 - 20) * 100) / 100);
    assert.equal((await (await get("/profit?missing=1")).json()).items[0].orderId, "22-2");

    const pnl = await (await get("/pnl")).json();
    assert.equal(pnl.months[0].month, now.toISOString().slice(0, 7));
    assert.equal(pnl.months[0].orders, 2);

    const labels = await (await get("/transactions?type=SHIPPING_LABEL")).json();
    assert.equal(labels.total, 1);
    assert.equal(labels.totals.amount, -8);
    assert.equal((await (await get("/transactions?from=2000-01-01&to=2000-12-31")).json()).total, 0);
    const bad = await fetch(`${base}/stores/${store._id}/finances/transactions?type=NOPE`, { headers: { cookie } });
    assert.equal(bad.status, 400);

    const csv = await get("/transactions.csv?type=SALE");
    assert.match(csv.headers.get("content-disposition")!, /attachment; filename="transactions-/);
    assert.equal((await csv.text()).trim().split("\r\n").length, 3);

    const summary = await (await get("/summary")).json();
    assert.equal(summary.needsDigitalSignature, false);
    assert.equal((await fetch(`${base}/stores/${store._id}/finances/summary`)).status, 401);
  } finally {
    server.close();
  }
});
