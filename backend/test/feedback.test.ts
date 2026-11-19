/** Feedback module: sync mapping, incremental paging, counts, auto-feedback (off by default), reply/leave API. Fake eBay. */
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
import { errorHandler } from "../src/middleware/error";
import { AUTH_COOKIE, requireAuth, signSession } from "../src/middleware/auth";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import { SyncState } from "../src/models/SyncState";
import feedbackModule from "../src/modules/feedback";
import { parseFeedbackDetail } from "../src/modules/feedback/ebay";
import { Feedback, FeedbackAwaiting, FeedbackSettings, feedbackSettings } from "../src/modules/feedback/model";
import { feedbackRouter } from "../src/modules/feedback/routes";
import { feedbackCounts, syncFeedback } from "../src/modules/feedback/service";
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

const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const makeStore = () =>
  Store.create({
    userId: new mongoose.Types.ObjectId(),
    ebayUserId: "my_shop",
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: [] },
    settings: structuredClone(DEFAULT_SETTINGS),
  }) as Promise<StoreDocument>;

const detail = (o: { id: string; type: string; days: number; user?: string; text?: string; response?: string; role?: string }) =>
  `<FeedbackDetail><CommentingUser>${o.user ?? "buyer_" + o.id}</CommentingUser><CommentingUserScore>42</CommentingUserScore>` +
  `<CommentText>${o.text ?? "comment " + o.id}</CommentText><CommentTime>${ago(o.days)}</CommentTime><CommentType>${o.type}</CommentType>` +
  `<ItemID>11${o.id}</ItemID><Role>${o.role ?? "Seller"}</Role><FeedbackID>${o.id}</FeedbackID><TransactionID>t${o.id}</TransactionID>` +
  `<ItemTitle>Brake pads ${o.id}</ItemTitle><ItemPrice currencyID="USD">38.99</ItemPrice>` +
  (o.response ? `<FeedbackResponse>${o.response}</FeedbackResponse>` : "") +
  `</FeedbackDetail>`;

const SUMMARY =
  `<FeedbackSummary><PositiveFeedbackPeriodArray><FeedbackPeriod><PeriodInDays>30</PeriodInDays><Count>12</Count></FeedbackPeriod>` +
  `<FeedbackPeriod><PeriodInDays>365</PeriodInDays><Count>150</Count></FeedbackPeriod></PositiveFeedbackPeriodArray>` +
  `<NegativeFeedbackPeriodArray><FeedbackPeriod><PeriodInDays>30</PeriodInDays><Count>1</Count></FeedbackPeriod></NegativeFeedbackPeriodArray>` +
  `</FeedbackSummary>`;

const AWAITING =
  `<ItemsAwaitingFeedback><TransactionArray>` +
  `<Transaction><Buyer><UserID>happy_buyer</UserID></Buyer><TransactionID>900</TransactionID><OrderLineItemID>55-900</OrderLineItemID>` +
  `<Item><ItemID>5501</ItemID><Title>Oxygen sensor</Title><ListingDetails><EndTime>${ago(2)}</EndTime></ListingDetails></Item></Transaction>` +
  // something WE bought: no Buyer element -> not ours to rate
  `<Transaction><Seller><UserID>other_seller</UserID></Seller><TransactionID>901</TransactionID><Item><ItemID>5502</ItemID></Item></Transaction>` +
  `</TransactionArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ItemsAwaitingFeedback>`;

function ebay(opts: { receivedPages?: string[][] } = {}) {
  const received = opts.receivedPages ?? [
    [
      detail({ id: "1", type: "Positive", days: 1 }),
      detail({ id: "2", type: "Negative", days: 3, text: "Arrived late" }),
      detail({ id: "3", type: "Neutral", days: 5, response: "Sorry about that!" }),
      detail({ id: "4", type: "Negative", days: 60 }),
      detail({ id: "5", type: "IndependentlyWithdrawn", days: 2 }),
    ],
  ];
  return fakeTrading({
    GetFeedback: (xml) => {
      if (xml.includes("FeedbackLeft")) {
        return `<FeedbackDetailArray>${detail({ id: "L1", type: "Positive", days: 1, user: "my_shop", role: "Buyer" })}</FeedbackDetailArray>` +
          `<PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>`;
      }
      const page = Number(/<PageNumber>(\d+)</.exec(xml)![1]);
      return `<FeedbackDetailArray>${(received[page - 1] ?? []).join("")}</FeedbackDetailArray>` +
        `<PaginationResult><TotalNumberOfPages>${received.length}</TotalNumberOfPages></PaginationResult>${page === 1 ? SUMMARY : ""}`;
    },
    GetUser: () => `<User><UserID>my_shop</UserID><FeedbackScore>1234</FeedbackScore><PositiveFeedbackPercent>99.6</PositiveFeedbackPercent><FeedbackRatingStar>Turquoise</FeedbackRatingStar></User>`,
    GetItemsAwaitingFeedback: () => AWAITING,
    LeaveFeedback: (_xml, n) => `<FeedbackID>left-${n}</FeedbackID>`,
    RespondToFeedback: () => "",
  });
}

test("parse: single FeedbackDetail is an object, left feedback doesn't name us as the buyer", () => {
  const f = parseFeedbackDetail(
    { FeedbackID: "9", CommentTime: ago(1), CommentType: "Positive", CommentingUser: "My_Shop", ItemPrice: { "#text": "5.00", "@_currencyID": "GBP" } },
    "FeedbackLeft",
    "my_shop",
  )!;
  assert.equal(f.direction, "left");
  assert.equal(f.user, "");
  assert.equal(f.itemPrice, 5);
  assert.equal(f.currency, "GBP");
  assert.equal(parseFeedbackDetail({ FeedbackID: "x", CommentType: "Positive" }, "FeedbackReceivedAsSeller", "me"), null, "no date");
});

test("sync: maps received/left/awaiting/profile, saves cursor, counts unanswered neutral/negative, auto-feedback off", async () => {
  const store = await makeStore();
  const fake = ebay();
  const runs = await runAccountSync(store, ["feedback"], { trading: fake } as any);
  assert.deepEqual(runs.map((r) => [r.module, r.ok]), [["feedback", true]], runs[0]?.summary);
  assert.match(runs[0].summary, /5 received, 1 left, 1 awaiting/);

  const received = await Feedback.find({ storeId: store._id, direction: "received" }).sort({ feedbackId: 1 }).lean();
  assert.deepEqual(received.map((f) => [f.feedbackId, f.rating]), [
    ["1", "Positive"], ["2", "Negative"], ["3", "Neutral"], ["4", "Negative"], ["5", "Withdrawn"],
  ]);
  const neg = received[1];
  assert.equal(neg.user, "buyer_2");
  assert.equal(neg.comment, "Arrived late");
  assert.equal(neg.itemId, "112");
  assert.equal(neg.itemPrice, 38.99);
  assert.equal(neg.transactionId, "t2");
  assert.equal(received[2].response, "Sorry about that!");
  const left = await Feedback.findOne({ storeId: store._id, direction: "left" }).lean();
  assert.equal(left?.user, "", "eBay named us as commenting user");

  const awaiting = await FeedbackAwaiting.find({ storeId: store._id }).lean();
  assert.deepEqual(awaiting.map((a) => [a.buyer, a.itemId, a.orderLineItemId]), [["happy_buyer", "5501", "55-900"]]);

  const s = await FeedbackSettings.findOne({ storeId: store._id }).lean();
  assert.equal(s?.autoPositive, false, "auto-feedback is OFF by default");
  assert.equal(s?.profile?.score, 1234);
  assert.equal(s?.profile?.positivePercent, 99.6);
  assert.deepEqual(s?.profile?.periods?.["30"], { positive: 12, neutral: 0, negative: 1 });
  assert.equal(s?.profile?.periods?.["90"], undefined, "eBay didn't send 90 days");
  assert.equal(fake.callsTo("LeaveFeedback").length, 0, "nothing left without opt-in");

  // only #2: negative, recent, no reply (#3 answered, #4 too old)
  assert.deepEqual(await feedbackCounts(store), { negativeFeedback: 1 });

  const st = await SyncState.findOne({ storeId: store._id, module: "feedback" }).lean();
  assert.equal(new Date(st!.cursor.received).toISOString().slice(0, 10), ago(1).slice(0, 10));
});

test("sync: incremental run stops paging once it passes the cursor; replies from eBay update, local replies survive", async () => {
  const store = await makeStore();
  const pages = [
    [detail({ id: "a", type: "Positive", days: 1 }), detail({ id: "b", type: "Negative", days: 20 })],
    [detail({ id: "c", type: "Positive", days: 40 })],
    [detail({ id: "d", type: "Positive", days: 80 })],
  ];
  await syncFeedback({ store, clients: { trading: ebay({ receivedPages: pages }) } as any, cursor: null, lastSuccessAt: null, log: () => {} });
  assert.equal(await Feedback.countDocuments({ storeId: store._id, direction: "received" }), 4, "first run reads every page");

  await Feedback.updateOne({ storeId: store._id, feedbackId: "b" }, { $set: { response: "We posted this" } });
  const fake = ebay({ receivedPages: pages });
  await syncFeedback({ store, clients: { trading: fake } as any, cursor: { received: ago(1), left: ago(1) }, lastSuccessAt: null, log: () => {} });
  const receivedCalls = fake.callsTo("GetFeedback").filter((c) => c.xml.includes("ReceivedAsSeller"));
  assert.equal(receivedCalls.length, 1, "page 1 already reaches past the cursor");
  assert.equal((await Feedback.findOne({ storeId: store._id, feedbackId: "b" }).lean())?.response, "We posted this");
});

test("sync: auto-positive feedback only when opted in", async () => {
  const store = await makeStore();
  const s = await feedbackSettings(store._id);
  s.autoPositive = true;
  s.autoText = "Thanks for buying!";
  await s.save();
  const fake = ebay();
  const r = await syncFeedback({ store, clients: { trading: fake } as any, cursor: null, lastSuccessAt: null, log: () => {} });
  assert.match(r.summary!, /1 auto-left/);
  const calls = fake.callsTo("LeaveFeedback");
  assert.equal(calls.length, 1);
  assert.match(calls[0].xml, /<OrderLineItemID>55-900<\/OrderLineItemID>/);
  assert.match(calls[0].xml, /<CommentType>Positive<\/CommentType>/);
  assert.match(calls[0].xml, /<TargetUser>happy_buyer<\/TargetUser>/);
  assert.match(calls[0].xml, /Thanks for buying!/);
  assert.equal(await FeedbackAwaiting.countDocuments({ storeId: store._id }), 0);
  assert.equal(await Feedback.countDocuments({ storeId: store._id, direction: "left", user: "happy_buyer" }), 1);
});

test("API: list filters, summary, reply (once), bulk leave with per-item results, settings", async () => {
  const userId = new mongoose.Types.ObjectId();
  const store = (await Store.create({
    userId,
    ebayUserId: "my_shop",
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: [] },
    settings: structuredClone(DEFAULT_SETTINGS),
  })) as StoreDocument;
  const fake = ebay();
  await syncFeedback({ store, clients: { trading: fake } as any, cursor: null, lastSuccessAt: null, log: () => {} });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/stores/:storeId/feedback", requireAuth, feedbackRouter(() => fake));
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stores/${store._id}/feedback`;
  const headers = { cookie: `${AUTH_COOKIE}=${signSession(String(userId))}`, "Content-Type": "application/json" };
  const get = async (p: string) => (await fetch(base + p, { headers })).json();
  const post = (p: string, body: unknown, method = "POST") => fetch(base + p, { method, headers, body: JSON.stringify(body) });
  try {
    assert.equal((await get("?rating=negative")).total, 2);
    assert.equal((await get("?direction=left")).total, 1);
    const needs = await get("?rating=needs_reply");
    assert.deepEqual(needs.items.map((f: any) => f.feedbackId), ["2"]);

    const sum = await get("/summary");
    assert.equal(sum.score, 1234);
    assert.equal(sum.periods["30"].source, "ebay");
    assert.equal(sum.periods["90"].source, "synced");
    assert.deepEqual([sum.periods["90"].positive, sum.periods["90"].negative], [1, 2]);
    assert.equal(sum.needsReply, 1);
    assert.equal(sum.settings.autoPositive, false);

    const tooLong = await post(`/${needs.items[0]._id}/reply`, { text: "x".repeat(81) });
    assert.equal(tooLong.status, 400);
    const ok = await post(`/${needs.items[0]._id}/reply`, { text: "Sorry - refund sent." });
    assert.equal(ok.status, 200);
    assert.match(fake.callsTo("RespondToFeedback")[0].xml, /<TargetUserID>buyer_2<\/TargetUserID>.*<ResponseType>Reply<\/ResponseType>/);
    assert.equal((await post(`/${needs.items[0]._id}/reply`, { text: "again" })).status, 400, "only one reply");
    assert.equal((await get("/summary")).needsReply, 0);

    const awaiting = await get("/awaiting");
    const res = await (await post("/leave", { ids: [awaiting.items[0]._id, String(new mongoose.Types.ObjectId())], text: "Great buyer!" })).json();
    assert.deepEqual(res.results.map((r: any) => r.ok), [true, false]);
    assert.equal((await get("/awaiting")).total, 0);

    const put = await (await post("/settings", { autoPositive: true }, "PUT")).json();
    assert.equal(put.settings.autoPositive, true);
  } finally {
    server.close();
  }
});

test("module is ready", () => {
  assert.equal(feedbackModule.ready, true);
  assert.ok(feedbackModule.sync && feedbackModule.counts && feedbackModule.router);
});
