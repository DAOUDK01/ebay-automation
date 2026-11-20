/** Returns module: Post-Order mapping, sync, counts, inbox API and confirm-gated action payloads (fake eBay). */
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
import returnsModule, { returnsCounts } from "../src/modules/returns";
import { actions, mapCancellation, mapCase, mapReturn, mapTimeline } from "../src/modules/returns/ebay";
import { PostOrderCase } from "../src/modules/returns/model";
import { availableActions, buildAction, deps } from "../src/modules/returns/router";
import { searchFrom, syncReturns } from "../src/modules/returns/sync";

let mongo: MongoMemoryServer;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

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

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const RETURN = {
  returnId: "5000123",
  buyerLoginName: "buyer_bob",
  currentType: "MONEY_BACK",
  state: "RETURN_REQUESTED",
  status: "RETURN_REQUESTED",
  creationInfo: {
    item: { itemId: "256100000001", transactionId: "2001", returnQuantity: 1 },
    reason: "NOT_AS_DESCRIBED",
    comments: { content: "Wrong size" },
    creationDate: { value: inDays(-2) },
  },
  sellerTotalRefund: { estimatedRefundAmount: { value: 74.5, currency: "USD" } },
  sellerResponseDue: { activityDue: "SELLER_APPROVE_REQUEST", respondByDate: { value: inDays(1) } },
};
const CLOSED_RETURN = {
  ...RETURN,
  returnId: "5000999",
  state: "CLOSED",
  status: "CLOSED",
  sellerTotalRefund: { estimatedRefundAmount: { value: 20, currency: "USD" }, actualRefundAmount: { value: 20, currency: "USD" } },
};
const CANCEL = {
  cancelId: "7000555",
  legacyOrderId: "256100000002-3003",
  cancelState: "INITIATED",
  cancelStatus: "CANCEL_REQUESTED",
  buyerLoginName: "carol99",
  cancelReason: "BUYER_ASKED_CANCEL",
  requestRefundAmount: { value: 16.95, currency: "USD" },
  cancelRequestDate: { value: inDays(-1) },
  sellerResponseDueDate: { value: inDays(3) },
};
const CASE = {
  caseId: "5100777",
  caseType: "ITEM_NOT_RECEIVED",
  caseStatusEnum: "OPEN",
  buyer: "dave_d",
  itemId: "256100000003",
  transactionId: "4004",
  claimAmount: { value: 34, currency: "USD" },
  creationDate: { value: inDays(-5) },
  respondByDate: { value: inDays(-0.1) },
};

const makeStore = (userId = new mongoose.Types.ObjectId()) =>
  Store.create({
    userId,
    ebayUserId: `seller${Math.random()}`,
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: USER_SCOPES },
    settings: structuredClone(DEFAULT_SETTINGS),
  }) as Promise<StoreDocument>;

/** Fake Post-Order client: canned search pages, records every call. */
function fakePostOrder(pages: Record<string, any[]>) {
  const calls: { method: string; path: string; query?: any; body?: any }[] = [];
  return {
    calls,
    async get(path: string, query?: any) {
      calls.push({ method: "GET", path, query });
      if (path.includes("/return/search")) return query.offset === 1 ? { members: pages.return ?? [], paginationOutput: { totalPages: 1 } } : { members: [] };
      if (path.includes("/cancellation/search")) return { cancellations: query.offset === 1 ? pages.cancellation ?? [] : [], paginationOutput: { totalPages: 1 } };
      if (path.includes("/casemanagement/search")) return { members: query.offset === 1 ? pages.case ?? [] : [], paginationOutput: { totalPages: 1 } };
      if (path.startsWith("/post-order/v2/return/")) {
        return {
          summary: { ...RETURN, state: "RETURN_ACCEPTED", status: "RETURN_ACCEPTED" },
          detail: {
            itemDetail: { itemTitle: "Rear Brake Rotors" },
            responseHistory: [
              { activity: "BUYER_CREATE_RETURN", author: "BUYER", creationDate: { value: inDays(-2) }, notes: "Wrong size" },
              { activity: "SELLER_APPROVE_REQUEST", author: "SELLER", creationDate: { value: inDays(0) } },
            ],
          },
        };
      }
      throw new Error("not found");
    },
    async post(path: string, body?: any) {
      calls.push({ method: "POST", path, body });
      return {};
    },
  };
}

test("mapping: returns, cancellations, cases and timeline", () => {
  const r = mapReturn(RETURN);
  assert.equal(r.kind, "return");
  assert.equal(r.ebayId, "5000123");
  assert.equal(r.buyer, "buyer_bob");
  assert.equal(r.itemId, "256100000001");
  assert.equal(r.orderId, "256100000001-2001");
  assert.equal(r.open, true);
  assert.deepEqual(r.amount, { value: 74.5, currency: "USD" });
  assert.equal(r.dueAction, "SELLER_APPROVE_REQUEST");
  assert.ok(r.respondBy instanceof Date);
  assert.equal(r.comments, "Wrong size");

  const closed = mapReturn(CLOSED_RETURN);
  assert.equal(closed.open, false);
  assert.equal(closed.respondBy, null, "no deadline once closed");
  assert.deepEqual(closed.refunded, { value: 20, currency: "USD" });

  const c = mapCancellation(CANCEL);
  assert.equal(c.kind, "cancellation");
  assert.equal(c.itemId, "256100000002");
  assert.equal(c.transactionId, "3003");
  assert.equal(c.open, true);
  assert.ok(c.respondBy);
  assert.equal(mapCancellation({ ...CANCEL, cancelState: "CLOSED", cancelStatus: "CANCEL_CLOSED_WITH_REFUND" }).open, false);

  const k = mapCase(CASE);
  assert.equal(k.type, "ITEM_NOT_RECEIVED");
  assert.equal(k.buyer, "dave_d");
  assert.equal(k.open, true);
  assert.equal(mapCase({ ...CASE, caseStatusEnum: "CLOSED" }).open, false);

  const tl = mapTimeline("return", { detail: { responseHistory: [{ activity: "B", author: "seller", creationDate: { value: inDays(0) } }, { activity: "A", author: "BUYER", creationDate: { value: inDays(-1) } }] } });
  assert.deepEqual(tl.map((e) => [e.action, e.actor]), [["A", "BUYER"], ["B", "SELLER"]]);
});

test("sync: upserts all three kinds, item titles from listings, cursor and counts", async () => {
  const store = await makeStore();
  await Listing.create({ storeId: store._id, itemId: "256100000001", title: "Rear Brake Rotors Pair" });
  const po = fakePostOrder({ return: [RETURN, CLOSED_RETURN], cancellation: [CANCEL], case: [CASE] });
  const r = await syncReturns({ store, clients: { postOrder: po } as any, cursor: null, lastSuccessAt: null, log: () => {} });
  assert.match(r.summary!, /2 returns \(2 new\), 1 cancellations \(1 new\), 1 cases \(1 new\)/);
  assert.ok((r.cursor as any).at);
  const searches = po.calls.filter((c) => c.method === "GET");
  assert.equal(searches.find((c) => c.path.includes("/return/search"))?.query.role, "SELLER");
  assert.ok(searches.find((c) => c.path.includes("/casemanagement/search"))?.query.case_creation_date_range_from);

  const ret = await PostOrderCase.findOne({ storeId: store._id, kind: "return", ebayId: "5000123" }).lean();
  assert.equal(ret?.itemTitle, "Rear Brake Rotors Pair");
  assert.deepEqual(await returnsCounts(store), { openReturns: 2, openCases: 1 });

  // second run: case closed on eBay -> updated, not duplicated; cursor used
  const po2 = fakePostOrder({ case: [{ ...CASE, caseStatusEnum: "CLOSED" }] });
  await syncReturns({ store, clients: { postOrder: po2 } as any, cursor: r.cursor, lastSuccessAt: null, log: () => {} });
  assert.equal(await PostOrderCase.countDocuments({ storeId: store._id }), 4);
  assert.deepEqual(await returnsCounts(store), { openReturns: 2, openCases: 0 });
});

test("sync: search window starts at the cursor minus overlap, or the oldest open row", async () => {
  const store = await makeStore();
  const now = new Date("2026-11-20T00:00:00Z");
  const cursor = new Date("2026-11-19T00:00:00Z");
  assert.equal((await searchFrom(store._id, "return", cursor, now)).toISOString(), "2026-10-20T00:00:00.000Z");
  await PostOrderCase.create({ storeId: store._id, kind: "return", ebayId: "old", open: true, openedAt: new Date("2026-08-01T00:00:00Z") });
  assert.equal((await searchFrom(store._id, "return", cursor, now)).toISOString(), "2026-07-31T00:00:00.000Z");
  assert.equal((await searchFrom(store._id, "case", null, now)).toISOString(), "2026-07-23T00:00:00.000Z", "first sync: 120 days");
});

test("sync: a failing search fails the run (cursor not advanced) but saves the others", async () => {
  const store = await makeStore();
  const po = fakePostOrder({ return: [RETURN] });
  const orig = po.get.bind(po);
  po.get = async (path: string, q?: any) => {
    if (path.includes("casemanagement")) throw new Error("eBay 500");
    return orig(path, q);
  };
  await assert.rejects(syncReturns({ store, clients: { postOrder: po } as any, cursor: null, lastSuccessAt: null, log: () => {} }), /cases: eBay 500/);
  assert.equal(await PostOrderCase.countDocuments({ storeId: store._id, kind: "return" }), 1);
});

test("action payloads", () => {
  assert.deepEqual(buildAction("return", "approve", "R1", {}), {
    path: "/post-order/v2/return/R1/decide",
    body: { decision: "ACCEPT" },
    label: "Approved the return",
  });
  assert.deepEqual(buildAction("return", "decline", "R1", { note: "Item was used" }).body, { decision: "DECLINE", comments: { content: "Item was used" } });
  assert.throws(() => buildAction("return", "decline", "R1", {}), /buyer why/);
  const refund = buildAction("return", "refund", "R1", { amount: 10.555 }, "USD");
  assert.equal(refund.path, "/post-order/v2/return/R1/issue_refund");
  assert.deepEqual(refund.body, {
    refundDetail: { itemizedRefundDetail: [{ refundAmount: { value: 10.56, currency: "USD" }, refundFeeType: "PURCHASE_PRICE" }], totalAmount: { value: 10.56, currency: "USD" } },
  });
  assert.equal(buildAction("return", "mark_received", "R1", {}).path, "/post-order/v2/return/R1/mark_as_received");
  assert.deepEqual(buildAction("return", "message", "R1", { text: " Hi " }).body, { message: { content: "Hi" } });
  assert.deepEqual(buildAction("cancellation", "approve", "C1", {}), actions.approveCancellation("C1"));
  assert.deepEqual(buildAction("cancellation", "reject", "C1", { trackingNumber: "1Z999", shippedDate: "2026-11-18" }).body, {
    trackingNumber: "1Z999",
    shipmentDate: { value: "2026-11-18T00:00:00.000Z" },
  });
  assert.deepEqual(buildAction("case", "tracking", "K1", { carrier: "UPS", trackingNumber: "1Z1" }), {
    path: "/post-order/v2/casemanagement/K1/provide_shipment_info",
    body: { shippingCarrierName: "UPS", trackingNumber: "1Z1" },
    label: "Sent tracking UPS 1Z1",
  });
  assert.equal(buildAction("case", "refund", "K1", {}).path, "/post-order/v2/casemanagement/K1/issue_refund");
  assert.throws(() => buildAction("case", "approve", "K1", {}), /Can't approve a case/);

  assert.deepEqual(availableActions({ kind: "return", open: true, status: "RETURN_REQUESTED" }), ["approve", "decline", "refund", "message"]);
  assert.deepEqual(availableActions({ kind: "return", open: true, status: "ITEM_DELIVERED" }), ["mark_received", "refund", "message"]);
  assert.deepEqual(availableActions({ kind: "cancellation", open: false, status: "CLOSED" }), []);
});

test("API: inbox filters, detail, actions need confirm and hit eBay once", async () => {
  assert.equal(returnsModule.ready, true);
  const reg = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `r${Date.now()}@x.test`, password: "password-123", name: "U" }),
  });
  const cookie = reg.headers.get("set-cookie")!.split(";")[0];
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  const store = await makeStore(me.user.id ?? me.user._id);
  const seed = fakePostOrder({ return: [RETURN, CLOSED_RETURN], cancellation: [CANCEL], case: [CASE] });
  await syncReturns({ store, clients: { postOrder: seed } as any, cursor: null, lastSuccessAt: null, log: () => {} });
  const get = async (p: string) => (await fetch(`${base}/stores/${store._id}/returns${p}`, { headers: { cookie } })).json();
  const post = (p: string, body: any) =>
    fetch(`${base}/stores/${store._id}/returns${p}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const open = await get("");
  assert.equal(open.total, 3);
  assert.equal(open.items[0].ebayId, "5100777", "overdue case first");
  assert.equal(open.items[0].raw, undefined, "raw JSON not in the list");
  assert.deepEqual(open.summary, { open: { return: 1, cancellation: 1, case: 1 }, dueSoon: 2, overdue: 1 });
  assert.equal((await get("?state=closed")).total, 1);
  assert.equal((await get("?kind=cancellation")).items[0].ebayId, "7000555");
  assert.equal((await get("?due=overdue")).total, 1);
  assert.equal((await get("?q=bob&state=all")).total, 2);

  const detail = await get("/return/5000123");
  assert.equal(detail.item.buyer, "buyer_bob");
  assert.ok(detail.actions.includes("approve"));
  assert.equal((await fetch(`${base}/stores/${store._id}/returns/nope/1`, { headers: { cookie } })).status, 404);

  const po = fakePostOrder({});
  deps.clients = () => ({ postOrder: po as any });
  const noConfirm = await post("/return/5000123/actions/approve", {});
  assert.equal(noConfirm.status, 400);
  assert.equal(po.calls.length, 0, "nothing sent without confirm");
  assert.equal((await post("/return/5000123/actions/refund", { confirm: true, amount: 500 })).status, 400, "more than paid");

  const ok = await post("/return/5000123/actions/approve", { confirm: true, note: "Sorry about that" });
  assert.equal(ok.status, 200);
  const sent = po.calls.filter((c) => c.method === "POST");
  assert.deepEqual(sent, [{ method: "POST", path: "/post-order/v2/return/5000123/decide", body: { decision: "ACCEPT", comments: { content: "Sorry about that" } } }]);
  const after = (await ok.json()).item;
  assert.equal(after.status, "RETURN_ACCEPTED", "refreshed from eBay after the action");
  assert.equal(after.itemTitle, "Rear Brake Rotors");
  assert.equal(after.timeline.length, 2);
  assert.equal(after.appActions[0].text, "Approved the return");

  const bad = await post("/cancellation/7000555/actions/refund", { confirm: true });
  assert.equal(bad.status, 400);

  // eBay rejects -> 502 with eBay's message, nothing logged
  po.post = async () => {
    throw new Error("Return is not in a valid state");
  };
  const rej = await post("/case/5100777/actions/refund", { confirm: true });
  assert.equal(rej.status, 502);
  assert.match((await rej.json()).error, /valid state/);
  assert.equal((await PostOrderCase.findOne({ ebayId: "5100777" }).lean())?.appActions.length, 0);
});
