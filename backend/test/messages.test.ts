/** Messages module: Trading mapping, sync merge, counts, threads API, reply payloads, Claude draft (fake). */
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
import { Proposal } from "../src/models/Proposal";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import { Usage } from "../src/models/Usage";
import messagesModule, { messagesCounts } from "../src/modules/messages";
import type { DraftInput } from "../src/modules/messages/draft";
import { Message, threadIdOf, threadKeyFromId, threadKeyOf } from "../src/modules/messages/model";
import { deps } from "../src/modules/messages/router";
import { dedupeOutbound, syncMessages } from "../src/modules/messages/sync";
import { buildMarkReadXml, buildPartnerXml, buildRtqXml, mapMemberExchange, mapMyMessage, messageBody } from "../src/modules/messages/trading";

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

const SELLER = "demo_parts_outlet";
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// Parsed Trading responses look like fast-xml-parser output: strings, single children not in arrays.
const HEADER_Q = {
  Sender: "buyer_bob",
  RecipientUserID: SELLER,
  Subject: "Question about item #256100000001",
  MessageID: "900001",
  ExternalMessageID: "Q-1",
  Read: "false",
  Replied: "false",
  ReceiveDate: ago(3),
  ItemID: "256100000001",
  ItemTitle: "Rear Brake Rotors Pair Toyota Camry 2018-2023",
  MessageType: "AskSellerQuestion",
  QuestionType: "General",
  ResponseDetails: { ResponseEnabled: "true" },
  Folder: { FolderID: "0" },
};
const HEADER_ORDER = {
  Sender: "carol99",
  RecipientUserID: SELLER,
  Subject: "When will it ship?",
  MessageID: "900002",
  Read: "true",
  ReceiveDate: ago(30),
  ItemID: "256100000002",
  MessageType: "ContactTransactionPartner",
  Folder: { FolderID: "0" },
};
const HEADER_EBAY = { Sender: "eBay", Subject: "Your invoice", MessageID: "900003", Read: "false", ReceiveDate: ago(2), Folder: { FolderID: "0" } };
const HEADER_SENT = {
  Sender: SELLER,
  RecipientUserID: "carol99",
  Subject: "Re: When will it ship?",
  MessageID: "900004",
  ReceiveDate: ago(29),
  ItemID: "256100000002",
  MessageType: "ContactTransactionPartner",
  Folder: { FolderID: "1" },
};
const EXCHANGE = {
  Item: { ItemID: "256100000001", Title: "Rear Brake Rotors Pair Toyota Camry 2018-2023" },
  Question: { MessageID: "Q-1", SenderID: "buyer_bob", RecipientID: SELLER, Subject: "Fitment", Body: "Will this fit a 2019 Camry SE?", MessageType: "AskSellerQuestion" },
  MessageStatus: "Unanswered",
  CreationDate: ago(3),
};

/** Fake Trading client: canned responses per call, records requests. */
function fakeTrading(opts: { headers?: any[]; sent?: any[]; exchanges?: any[] } = {}) {
  const calls: { name: string; xml: string }[] = [];
  return {
    calls,
    async call(name: string, xml: string) {
      calls.push({ name, xml });
      if (name === "GetMyMessages" && xml.includes("ReturnHeaders")) {
        const rows = xml.includes("<FolderID>1</FolderID>") ? opts.sent ?? [] : opts.headers ?? [];
        return { Messages: rows.length === 1 ? { Message: rows[0] } : { Message: rows }, PaginationResult: { TotalNumberOfPages: "1" } };
      }
      if (name === "GetMyMessages") {
        const ids = [...xml.matchAll(/<MessageID>(.*?)<\/MessageID>/g)].map((m) => m[1]);
        return { Messages: { Message: ids.map((id) => ({ MessageID: id, Text: `<html><body><p>Body of ${id}</p></body></html>` })) } };
      }
      if (name === "GetMemberMessages") return { MemberMessage: { MemberMessageExchange: opts.exchanges ?? [] }, PaginationResult: { TotalNumberOfPages: "1" } };
      return { Ack: "Success" };
    },
    async getItem(): Promise<any> {
      throw new Error("no eBay in tests");
    },
  };
}

const makeStore = (userId = new mongoose.Types.ObjectId()) =>
  Store.create({
    userId,
    ebayUserId: SELLER,
    name: "Demo Parts Outlet",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: USER_SCOPES },
    settings: structuredClone(DEFAULT_SETTINGS),
  }) as Promise<StoreDocument>;

test("mapping: GetMyMessages headers, bodies, member questions, thread ids", () => {
  const q = mapMyMessage(HEADER_Q, SELLER);
  assert.equal(q.key, "Q-1", "external id is the dedupe key");
  assert.equal(q.messageId, "900001");
  assert.equal(q.direction, "in");
  assert.equal(q.buyer, "buyer_bob");
  assert.equal(q.threadKey, "buyer_bob|256100000001");
  assert.equal(q.read, false);
  assert.equal(q.responseEnabled, true);
  const sent = mapMyMessage(HEADER_SENT, SELLER);
  assert.equal(sent.direction, "out");
  assert.equal(sent.buyer, "carol99");
  assert.equal(sent.read, true);

  assert.equal(messageBody({ Content: " plain text " }), "plain text");
  assert.equal(messageBody({ Text: "<div>Hi&nbsp;there</div><style>x{}</style>" }), "Hi there");

  const [question, answer] = mapMemberExchange({ ...EXCHANGE, MessageStatus: "Answered", Response: "Yes it fits." }, SELLER);
  assert.equal(question.key, "Q-1");
  assert.equal(question.body, "Will this fit a 2019 Camry SE?");
  assert.equal(question.replied, true);
  assert.equal(answer.direction, "out");
  assert.equal(answer.body, "Yes it fits.");

  const key = threadKeyOf("Buyer_Bob ", "123");
  assert.equal(key, "buyer_bob|123");
  assert.equal(threadKeyFromId(threadIdOf(key)), key);
});

test("request bodies: mark read, RTQ answer, partner message (escaped)", () => {
  assert.equal(buildMarkReadXml(["1", "2"]), "<MessageIDs><MessageID>1</MessageID><MessageID>2</MessageID></MessageIDs><Read>true</Read>");
  const rtq = buildRtqXml({ itemId: "256", parentId: "Q-1", buyer: "bob", body: "Yes <it> fits & ships" });
  assert.match(rtq, /^<ItemID>256<\/ItemID><MemberMessage><Body>Yes &lt;it&gt; fits &amp; ships<\/Body>/);
  assert.match(rtq, /<ParentMessageID>Q-1<\/ParentMessageID><RecipientID>bob<\/RecipientID>/);
  const p = buildPartnerXml({ itemId: "256", buyer: "carol", subject: "Re: ship", body: "Shipped today" });
  assert.match(p, /<QuestionType>General<\/QuestionType><RecipientID>carol<\/RecipientID><Subject>Re: ship<\/Subject>/);
});

test("sync: merges both calls, skips eBay notices, fetches bodies once, counts unread", async () => {
  const store = await makeStore();
  const t = fakeTrading({ headers: [HEADER_Q, HEADER_ORDER, HEADER_EBAY], sent: [HEADER_SENT], exchanges: [EXCHANGE] });
  const r = await syncMessages({ store, clients: { trading: t } as any, cursor: null, lastSuccessAt: null, log: () => {} });
  assert.ok((r.cursor as any).at);
  assert.match(r.summary!, /3 new/);
  assert.equal(await Message.countDocuments({ storeId: store._id }), 3, "Q-1 seen twice -> one row; eBay notice skipped");
  const q = await Message.findOne({ storeId: store._id, key: "Q-1" }).lean();
  assert.equal(q?.messageId, "900001");
  assert.equal(q?.body, "Will this fit a 2019 Camry SE?", "member body kept");
  assert.equal(q?.read, false);
  const order = await Message.findOne({ storeId: store._id, key: "900002" }).lean();
  assert.equal(order?.body, "Body of 900002", "body fetched for new headers");
  assert.deepEqual(await messagesCounts(store), { unreadMessages: 1 });

  // header window starts at cursor - 1 day; bodies aren't fetched again
  const t2 = fakeTrading({ headers: [{ ...HEADER_Q, Read: "true" }], exchanges: [EXCHANGE] });
  await syncMessages({ store, clients: { trading: t2 } as any, cursor: r.cursor, lastSuccessAt: null, log: () => {} });
  assert.ok(t2.calls[0].xml.includes(`<StartTime>${new Date(new Date((r.cursor as any).at).getTime() - 86_400_000).toISOString()}`));
  assert.equal(t2.calls.filter((c) => c.xml.includes("ReturnMessages")).length, 0);
  assert.deepEqual(await messagesCounts(store), { unreadMessages: 0 }, "read on eBay -> read here");
});

test("dedupe: a reply seen in Sent, in the question's Response and saved by the app is kept once", async () => {
  const store = await makeStore();
  const threadKey = threadKeyOf("bob", "1");
  const base = { storeId: store._id, threadKey, direction: "out", buyer: "bob", itemId: "1", bodyFetched: true };
  await Message.create([
    { ...base, key: "app:1", source: "app", body: "Yes it fits.", receivedAt: new Date(Date.now() - 60_000) },
    { ...base, key: "Q-1:r0", source: "member_messages", body: "Yes it  fits.", receivedAt: new Date() },
    { ...base, key: "900010", source: "my_messages", messageId: "900010", body: "yes it fits.", receivedAt: new Date() },
    { ...base, key: "900011", source: "my_messages", messageId: "900011", body: "Something else", receivedAt: new Date() },
  ]);
  assert.equal(await dedupeOutbound(store._id), 2);
  assert.deepEqual((await Message.find({ storeId: store._id }).sort({ key: 1 }).lean()).map((m) => m.key), ["900010", "900011"]);
});

test("API: threads, read, reply (confirm-gated), templates, Claude draft", async () => {
  assert.equal(messagesModule.ready, true);
  const reg = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `m${Date.now()}@x.test`, password: "password-123", name: "U" }),
  });
  const cookie = reg.headers.get("set-cookie")!.split(";")[0];
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  const store = await makeStore(me.user.id ?? me.user._id);
  await syncMessages({
    store,
    clients: { trading: fakeTrading({ headers: [HEADER_Q, HEADER_ORDER], sent: [HEADER_SENT], exchanges: [EXCHANGE] }) } as any,
    cursor: null,
    lastSuccessAt: null,
    log: () => {},
  });
  await Listing.create({ storeId: store._id, itemId: "256100000001", title: "Rear Brake Rotors Pair", price: 74.5 });
  await Proposal.create({
    storeId: store._id,
    itemId: "256100000001",
    status: "pushed",
    before: {
      title: "Rear Brake Rotors Pair Toyota Camry 2018-2023",
      price: 74.5,
      condition: "Used",
      itemSpecifics: { Brand: ["Toyota"], Placement: ["Rear"] },
      compatibilitySample: [{ Year: "2019", Make: "Toyota", Model: "Camry", Trim: "SE" }],
    },
  });

  const t = fakeTrading();
  deps.trading = () => t as any;
  const req = (p: string, body?: any, method = body ? "POST" : "GET") =>
    fetch(`${base}/stores/${store._id}/messages${p}`, {
      method,
      headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  const list = await (await req("/threads")).json();
  assert.equal(list.total, 2);
  assert.equal(list.unreadThreads, 1);
  const bob = list.items.find((x: any) => x.buyer === "buyer_bob");
  assert.equal(bob.unread, 1);
  assert.equal(bob.needsReply, true);
  const carol = list.items.find((x: any) => x.buyer === "carol99");
  assert.equal(carol.count, 2);
  assert.equal(carol.lastDirection, "out");
  assert.equal((await (await req("/threads?unread=1")).json()).total, 1);
  assert.equal((await (await req("/threads?q=camry%20se")).json()).items[0].buyer, "buyer_bob");

  const detail = await (await req(`/threads/${bob.id}`)).json();
  assert.equal(detail.thread.reply, "rtq");
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.listing.title, "Rear Brake Rotors Pair");
  assert.equal((await req(`/threads/${threadIdOf("nobody|1")}`)).status, 404);

  // mark read -> ReviseMyMessages with the GetMyMessages id
  const read = await (await req(`/threads/${bob.id}/read`, {})).json();
  assert.equal(read.updated, 1);
  assert.deepEqual(t.calls.map((c) => c.name), ["ReviseMyMessages"]);
  assert.match(t.calls[0].xml, /<MessageID>900001<\/MessageID>.*<Read>true<\/Read>/);

  // Claude draft: fake model, gets thread + listing context, records usage, sends nothing
  let seen: DraftInput | null = null;
  deps.draft = async (input, opts) => {
    seen = input;
    assert.equal(opts.model, DEFAULT_SETTINGS.claude.model);
    return { text: "Hi buyer_bob, yes - it fits a 2019 Camry SE. Thanks, Demo Parts Outlet", costUsd: 0.002, inputTokens: 900, outputTokens: 60 };
  };
  const callsBefore = t.calls.length;
  const draft = await req(`/threads/${bob.id}/draft`, { instructions: "keep it short" });
  assert.equal(draft.status, 200);
  assert.match((await draft.json()).text, /2019 Camry SE/);
  assert.equal(t.calls.length, callsBefore, "draft never calls eBay");
  const input = seen as unknown as DraftInput;
  assert.equal(input.buyer, "buyer_bob");
  assert.equal(input.thread[0].from, "buyer");
  assert.match(input.thread[0].body, /2019 Camry/);
  assert.deepEqual((input.listing as any).compatibility, [{ Year: "2019", Make: "Toyota", Model: "Camry", Trim: "SE" }]);
  assert.deepEqual((input.listing as any).itemSpecifics, { Brand: ["Toyota"], Placement: ["Rear"] });
  assert.equal(input.instructions, "keep it short");
  assert.equal((await Usage.findOne({ storeId: store._id }).lean())?.usd, 0.002);

  // over budget -> refused before calling Claude
  await Usage.updateOne({ storeId: store._id }, { $set: { usd: 1000 } });
  assert.equal((await req(`/threads/${bob.id}/draft`, {})).status, 402);

  // reply needs confirm; then RTQ to the question
  assert.equal((await req(`/threads/${bob.id}/reply`, { body: "Yes it fits" })).status, 400);
  assert.equal(t.calls.length, callsBefore);
  const sent = await req(`/threads/${bob.id}/reply`, { body: "Yes it fits", confirm: true });
  assert.equal(sent.status, 200);
  const rtq = t.calls[t.calls.length - 1];
  assert.equal(rtq.name, "AddMemberMessageRTQ");
  assert.match(rtq.xml, /<ParentMessageID>Q-1<\/ParentMessageID><RecipientID>buyer_bob<\/RecipientID>/);
  const after = await (await req(`/threads/${bob.id}`)).json();
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[1].direction, "out");
  assert.equal(after.messages[0].replied, true);

  // order buyer -> AAQToPartner
  await req(`/threads/${carol.id}/reply`, { body: "Shipped today", confirm: true });
  const partner = t.calls[t.calls.length - 1];
  assert.equal(partner.name, "AddMemberMessageAAQToPartner");
  assert.match(partner.xml, /<ItemID>256100000002<\/ItemID>.*<Subject>Re: When will it ship\?<\/Subject>/);
  // asking for RTQ where there is no question is refused
  assert.equal((await req(`/threads/${carol.id}/reply`, { body: "x", mode: "rtq", confirm: true })).status, 400);

  // eBay failure -> 502, nothing saved
  t.call = async () => {
    throw new Error("[21919] Invalid recipient");
  };
  const fail = await req(`/threads/${carol.id}/reply`, { body: "again", confirm: true });
  assert.equal(fail.status, 502);
  assert.equal(await Message.countDocuments({ storeId: store._id, source: "app" }), 2);

  // templates CRUD
  const created = await (await req("/templates", { name: "Fitment check", body: "Hi {buyer}, please send your VIN." })).json();
  assert.equal(created.template.name, "Fitment check");
  const tid = created.template._id;
  await req(`/templates/${tid}`, { body: "Hi {buyer}, send your VIN please." }, "PATCH");
  const tl = await (await req("/templates")).json();
  assert.equal(tl.templates[0].body, "Hi {buyer}, send your VIN please.");
  assert.equal((await req("/templates", { name: "" })).status, 400);
  assert.equal((await req(`/templates/${tid}`, undefined, "DELETE")).status, 200);
  assert.equal((await (await req("/templates")).json()).templates.length, 0);
});

// A trimmed copy of the HTML email eBay returns in GetMyMessages <Text>: logo, header table, the buyer's
// words inside <div id="UserInputtedText">, buttons and a footer.
const EBAY_EMAIL = `<!DOCTYPE html><html><head><title>eBay</title><style>.x{color:red}</style></head><body>
<table><tr><td><img src="https://p.ebaystatic.com/logo.png" alt="eBay"></td></tr>
<tr><td>New message from: <a href="https://www.ebay.com/usr/buyer_bob">buyer_bob</a> (12<img src="star.gif">)</td></tr>
<tr><td><div id="UserInputtedText">Hi,<br />Will this fit my 2019 Camry SE?<br><br>It&#39;s the 2.5L &amp; I need it by Friday.<br />Thanks,<br>Bob</div></td></tr>
<tr><td><a href="https://www.ebay.com/msg/reply">Reply</a></td></tr>
<tr><td>Item ID: 256100000001 &nbsp; End date: Dec-01-26</td></tr>
<tr><td>Only purchases on eBay are covered by the eBay purchase protection programs. Email reference id: [#a05-xyz#]_[#123#]</td></tr>
</table></body></html>`;

test("message text: only the buyer's words from eBay's email, line breaks and symbols kept", async () => {
  const { extractUserText, htmlToPlain } = await import("../src/modules/messages/trading");
  assert.equal(
    messageBody({ Text: EBAY_EMAIL }),
    "Hi,\nWill this fit my 2019 Camry SE?\n\nIt's the 2.5L & I need it by Friday.\nThanks,\nBob",
  );
  assert.ok(!messageBody({ Text: EBAY_EMAIL }).includes("Email reference"), "no eBay template text");
  // no UserInputtedText div -> whole HTML as text, still readable
  assert.equal(extractUserText("<p>Line one</p><p>Line&nbsp;two &rsquo;ok&rsquo;</p>"), "Line one\nLine two 'ok'");
  assert.equal(htmlToPlain("a&#x41;&#66;&unknown;"), "aAB&unknown;");
  // eBay system senders
  const { isSystemSender } = await import("../src/modules/messages/trading");
  assert.equal(isSystemSender("eBay"), true);
  assert.equal(isSystemSender("eBay Customer Service"), true);
  assert.equal(isSystemSender("ebaybuyer123"), false);
});

test("sync: old bodies holding the whole email are repaired from what's stored (no eBay call); orphan replies join the thread", async () => {
  const { attachOrphans, BODY_VERSION } = await import("../src/modules/messages/sync");
  const store = await makeStore();
  // what the previous version saved for an escaped email: the whole email's HTML as text
  await Message.create({
    storeId: store._id, key: "OLD-1", messageId: "800001", source: "my_messages", threadKey: "buyer_bob|256100000001",
    direction: "in", sender: "buyer_bob", buyer: "buyer_bob", itemId: "256100000001", body: EBAY_EMAIL,
    bodyFetched: true, bodyVersion: 2, receivedAt: new Date(Date.now() - 3600_000),
  });
  // an old body that was already clean: kept as it is
  await Message.create({
    storeId: store._id, key: "OLD-2", messageId: "800003", source: "my_messages", threadKey: "carol99|256100000002",
    direction: "in", sender: "carol99", buyer: "carol99", itemId: "256100000002", body: "Thanks, got it!",
    bodyFetched: true, bodyVersion: 2, receivedAt: new Date(Date.now() - 7200_000),
  });
  // my reply from the Sent folder without an item number
  await Message.create({
    storeId: store._id, key: "SENT-1", messageId: "800002", source: "my_messages", threadKey: "buyer_bob|",
    direction: "out", sender: SELLER, buyer: "buyer_bob", itemId: "", body: "Yes it fits", bodyFetched: true, bodyVersion: BODY_VERSION,
    receivedAt: new Date(),
  });
  const t = fakeTrading();
  (t as any).call = async (name: string, xml: string) => {
    if (name === "GetMyMessages" && xml.includes("ReturnMessages")) {
      const ids = [...xml.matchAll(/<MessageID>(.*?)<\/MessageID>/g)].map((m) => m[1]);
      return { Messages: { Message: ids.map((id) => ({ MessageID: id, Text: EBAY_EMAIL })) } };
    }
    if (name === "GetMyMessages") return { Messages: {}, PaginationResult: { TotalNumberOfPages: "1" } };
    return { MemberMessage: {}, PaginationResult: { TotalNumberOfPages: "1" } };
  };
  const bodyCalls: string[] = [];
  const inner = (t as any).call;
  (t as any).call = async (name: string, xml: string) => {
    if (name === "GetMyMessages" && xml.includes("ReturnMessages")) bodyCalls.push(xml);
    return inner(name, xml);
  };
  await syncMessages({ store, clients: { trading: t } as any, cursor: null, lastSuccessAt: null, log: () => {} });
  const old = await Message.findOne({ storeId: store._id, key: "OLD-1" }).lean();
  assert.match(old!.body, /^Hi,\nWill this fit/);
  assert.ok(!old!.body.includes("<"), "no HTML left");
  assert.equal(old!.bodyVersion, BODY_VERSION);
  assert.equal((await Message.findOne({ storeId: store._id, key: "OLD-2" }).lean())!.body, "Thanks, got it!");
  assert.equal(bodyCalls.length, 0, "repaired locally - nothing fetched from eBay again");
  const sent = await Message.findOne({ storeId: store._id, key: "SENT-1" }).lean();
  assert.equal(sent!.threadKey, "buyer_bob|256100000001", "reply joined the item conversation");
  assert.equal(await attachOrphans(store._id), 0, "nothing left to move");
});

// eBay's Text as it really arrives (the screenshot case): the email HTML is entity-escaped, with
// eBay's <!--..._START--> comments and the ebaylogo table; the buyer's words are in UserInputtedText,
// split into paragraph divs.
const ESCAPED_EMAIL = EBAY_EMAIL.replace("<html>", "<html><!--9f5e9f0a-3539-25f1-4628-b7bcd5cb8225_START--><table id=\"ebaylogo\" width=\"100%\"><tr><td>logo</td></tr></table><!--d30ae216-ff2d-6a16-937c-6390d2af7911_END-->")
  .replace(`<div id="UserInputtedText">Hi,<br />Will this fit my 2019 Camry SE?`, `<div id="UserInputtedText"><div>Hi,</div><div>Will this fit my 2019 Camry SE?</div>`)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

test("message text: escaped (and double-escaped) eBay email HTML, nested paragraph divs, no template", async () => {
  const { extractUserText, unescapeHtml, looksLikeRawEmail } = await import("../src/modules/messages/trading");
  const want = "Hi,\nWill this fit my 2019 Camry SE?\n\nIt's the 2.5L & I need it by Friday.\nThanks,\nBob";
  assert.equal(messageBody({ Text: ESCAPED_EMAIL }), want);
  assert.equal(messageBody({ Text: ESCAPED_EMAIL.replace(/&/g, "&amp;") }), want, "double-escaped");
  assert.equal(messageBody({ Content: ESCAPED_EMAIL }), want, "same escaped email in Content");
  // a buyer typing "&lt;" in plain text isn't turned into a tag
  assert.equal(unescapeHtml("5 &lt; 6 and that's fine"), "5 &lt; 6 and that's fine");
  assert.equal(extractUserText("Price is &lt; $50, ok?"), "Price is < $50, ok?");
  // an email without a UserInputtedText block: template lines are dropped
  const noMarker = `<table><tr><td>eBay</td></tr><tr><td>New message from: buyer_bob (12)</td></tr><tr><td><p>Is the left one still available?</p></td></tr><tr><td>Reply</td></tr><tr><td>Item ID: 256100000001</td></tr><tr><td>Email reference id: [#a05-xyz#]_[#123#]</td></tr><tr><td>© 1995-2026 eBay Inc. All Rights Reserved</td></tr></table>`;
  assert.equal(extractUserText(noMarker), "Is the left one still available?");
  assert.equal(looksLikeRawEmail(EBAY_EMAIL), true);
  assert.equal(looksLikeRawEmail("Thanks, got it!"), false);
});

test("repair: legacy rows without a bodyVersion field; cut-off copies are queued for download, readable ones cleaned", async () => {
  const { repairBodies, BODY_VERSION } = await import("../src/modules/messages/sync");
  const store = await makeStore();
  const raw = Message.collection; // bypass mongoose defaults: documents exactly as the first version saved them
  const base = { storeId: store._id, source: "my_messages", direction: "in", sender: "ygriega0.23", buyer: "ygriega0.23", itemId: "920096189681", bodyFetched: true, receivedAt: new Date() };
  // 1. whole email with the buyer's words inside -> cleaned locally
  await raw.insertOne({ ...base, key: "L-1", messageId: "700001", threadKey: "ygriega0.23|920096189681", body: EBAY_EMAIL });
  // 2. email cut off at 8000 chars before UserInputtedText -> downloaded again
  const cut = `<!--d30ae216-ff2d-6a16-937c-6390d2af7911_END-->\n    <table id="ebaylogo" width="100%">\n${"<tr><td style=\"border-collapse: collapse\">x</td></tr>\n".repeat(150)}`.slice(0, 8000);
  await raw.insertOne({ ...base, key: "L-2", messageId: "700002", threadKey: "ygriega0.23|920096189681", body: cut });
  // 3. clean legacy text -> untouched
  await raw.insertOne({ ...base, key: "L-3", messageId: "700003", threadKey: "ygriega0.23|920096189681", body: "Is this still available?" });
  assert.equal((await raw.findOne({ key: "L-1" }))!.bodyVersion, undefined, "really has no bodyVersion field");

  assert.deepEqual(await repairBodies(store._id), { cleaned: 1, refetch: 1 });
  const [l1, l2, l3] = await Promise.all(["L-1", "L-2", "L-3"].map((key) => Message.findOne({ storeId: store._id, key }).lean()));
  assert.match(l1!.body, /^Hi,\nWill this fit/);
  assert.equal(l2!.body, "");
  assert.equal(l2!.bodyFetched, false, "queued for download");
  assert.equal(l3!.body, "Is this still available?");
  assert.ok([l1, l2, l3].every((m) => m!.bodyVersion === BODY_VERSION));
  assert.deepEqual(await repairBodies(store._id), { cleaned: 0, refetch: 0 }, "runs once");
  // a plain message mentioning eBay keeps every line
  const { extractUserText } = await import("../src/modules/messages/trading");
  assert.equal(extractUserText("Hi, saw this on eBay\nReply when you can"), "Hi, saw this on eBay\nReply when you can");
});
