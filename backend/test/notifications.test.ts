/** Instant messages: subscribe request, signature check, webhook, throttled trigger, status API. */
process.env.JWT_SECRET = "test-secret";
process.env.ENCRYPTION_KEY = "test-key";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { encrypt } from "../src/lib/crypto";
import { USER_SCOPES } from "../src/lib/ebay/auth";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import {
  buildSubscribeXml,
  ensureSubscribed,
  expectedSignature,
  makeTrigger,
  MessageNotify,
  parseNotification,
  subscribe,
  verifyNotification,
} from "../src/modules/messages/notifications";
import { deps } from "../src/modules/messages/router";
import { notificationDeps } from "../src/routes/ebay";

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

const SELLER = "MotorSupply_Co";
const KEYS = { devId: "DEV-1", appId: "APP-1", certId: "CERT-1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const makeStore = (userId = new mongoose.Types.ObjectId(), ebayUserId = SELLER) =>
  Store.create({
    userId,
    ebayUserId,
    name: ebayUserId,
    auth: { refreshTokenEnc: encrypt("rt"), scopes: USER_SCOPES },
    settings: structuredClone(DEFAULT_SETTINGS),
  }) as Promise<StoreDocument>;

/** What eBay POSTs (trimmed): SOAP envelope, signature in the header, event + recipient in the body. */
const envelope = (o: { event?: string; recipient?: string; timestamp?: string; signature?: string }) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
 <soapenv:Header>
  <ebl:RequesterCredentials soapenv:mustUnderstand="0" xmlns:ebl="urn:ebay:apis:eBLBaseComponents">
   <ebl:NotificationSignature xmlns:ebl="urn:ebay:apis:eBLBaseComponents">${o.signature ?? ""}</ebl:NotificationSignature>
  </ebl:RequesterCredentials>
 </soapenv:Header>
 <soapenv:Body>
  <GetMyMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
   <Timestamp>${o.timestamp ?? new Date().toISOString()}</Timestamp>
   <Ack>Success</Ack>
   <NotificationEventName>${o.event ?? "MyMessagesM2MMessage"}</NotificationEventName>
   <RecipientUserID>${o.recipient ?? SELLER}</RecipientUserID>
   <Messages><Message><Sender>buyer_bob</Sender><RecipientUserID>someone_else</RecipientUserID><Text>&lt;div&gt;hi&lt;/div&gt;</Text></Message></Messages>
  </GetMyMessagesResponse>
 </soapenv:Body>
</soapenv:Envelope>`;

function fakeTrading(fail?: string) {
  const calls: { name: string; xml: string }[] = [];
  return {
    calls,
    async call(name: string, xml: string) {
      calls.push({ name, xml });
      if (fail) throw new Error(fail);
      return { Ack: "Success" };
    },
    async getItem(): Promise<any> {
      throw new Error("no eBay in tests");
    },
  };
}

test("subscribe request: named delivery URL + both message events, never the app-wide URL", () => {
  const xml = buildSubscribeXml("https://app.example.com/api/ebay/notifications?a=1&b=2");
  assert.match(xml, /<ApplicationEnable>Enable<\/ApplicationEnable>/);
  assert.match(xml, /<DeliveryURLDetails><DeliveryURLName>listing_optimizer_messages<\/DeliveryURLName><DeliveryURL>https:\/\/app\.example\.com\/api\/ebay\/notifications\?a=1&amp;b=2<\/DeliveryURL><Status>Enable<\/Status><\/DeliveryURLDetails>/);
  assert.match(xml, /<\/ApplicationDeliveryPreferences><DeliveryURLName>listing_optimizer_messages<\/DeliveryURLName>/, "points this user at our URL");
  assert.match(xml, /<EventType>AskSellerQuestion<\/EventType><EventEnable>Enable<\/EventEnable>/);
  assert.match(xml, /<EventType>MyMessagesM2MMessage<\/EventType><EventEnable>Enable<\/EventEnable>/);
  assert.doesNotMatch(xml, /ApplicationURL/, "the keyset's main URL belongs to the other app");
});

test("notification parsing + signature: valid, wrong, stale, missing, unverified", () => {
  const timestamp = "2026-11-20T10:00:00.000Z";
  const now = Date.parse(timestamp) + 30_000;
  const signature = expectedSignature(timestamp, KEYS.devId, KEYS.appId, KEYS.certId);
  const n = parseNotification(envelope({ timestamp, signature, event: "AskSellerQuestion" }));
  assert.deepEqual(n, { event: "AskSellerQuestion", recipient: SELLER, timestamp, signature });

  assert.equal(verifyNotification(n, KEYS, now), "valid");
  assert.equal(verifyNotification({ ...n, signature: "forged==" }, KEYS, now), "invalid");
  assert.equal(verifyNotification(n, KEYS, now + 60 * 60_000), "invalid", "replayed an hour later");
  assert.equal(verifyNotification({ ...n, signature: "" }, KEYS, now), "invalid");
  assert.equal(verifyNotification({ ...n, signature: "forged==" }, { ...KEYS, devId: "" }, now), "unverified", "no Dev ID: can't check");
  assert.deepEqual(parseNotification("not xml"), { event: "", recipient: "", timestamp: "", signature: "" });
});

test("trigger: a burst of notifications becomes one sync now + one follow-up", async () => {
  const runs: string[] = [];
  const fire = makeTrigger(async (id) => {
    runs.push(id);
    await sleep(20);
  }, 80);
  for (let i = 0; i < 5; i++) void fire("a");
  void fire("b");
  await sleep(10);
  assert.deepEqual(runs.sort(), ["a", "b"], "first one runs at once, per account");
  await sleep(150);
  assert.deepEqual(runs.filter((x) => x === "a").length, 2, "the rest were folded into one follow-up");
  await sleep(150);
  assert.equal(runs.filter((x) => x === "a").length, 2, "nothing more after that");

  // a failing sync doesn't break later triggers
  let n = 0;
  const flaky = makeTrigger(async () => {
    n++;
    throw new Error("eBay down");
  }, 0);
  await flaky("x");
  await flaky("x");
  assert.equal(n, 2);
});

test("subscribe / ensureSubscribed: https only, saves outcome, resubscribes on URL change, retries errors daily", async () => {
  const store = await makeStore(undefined, "sub_test_seller");

  const t0 = fakeTrading();
  const r0 = await subscribe(store._id, t0, "http://localhost:3100/api/ebay/notifications");
  assert.equal(r0.ok, false);
  assert.match(r0.error, /https/);
  assert.equal(t0.calls.length, 0, "eBay refuses http, so don't even ask");

  const t1 = fakeTrading();
  const url = "https://app.example.com/api/ebay/notifications";
  assert.equal((await subscribe(store._id, t1, url)).ok, true);
  assert.deepEqual(t1.calls.map((c) => c.name), ["SetNotificationPreferences"]);
  let st = await MessageNotify.findOne({ storeId: store._id }).lean();
  assert.ok(st?.enabledAt);
  assert.equal(st?.error, "");
  assert.equal(st?.url, url);

  // the live address = FRONTEND_URL/api unless PUBLIC_API_URL is set
  const saved = { publicApiUrl: env.publicApiUrl, frontendUrl: env.frontendUrl };
  try {
    env.publicApiUrl = "";
    env.frontendUrl = "https://app.example.com/";
    const t2 = fakeTrading();
    assert.equal(await ensureSubscribed(store._id, t2), null, "already on this address");
    assert.equal(t2.calls.length, 0);

    env.publicApiUrl = "https://api.example.com";
    const t3 = fakeTrading();
    assert.equal((await ensureSubscribed(store._id, t3))?.ok, true, "address moved: subscribe again");
    st = await MessageNotify.findOne({ storeId: store._id }).lean();
    assert.equal(st?.url, "https://api.example.com/ebay/notifications");

    // eBay error is saved and only retried a day later
    env.publicApiUrl = "https://api2.example.com";
    const t4 = fakeTrading("Notification preferences not allowed");
    const r4 = await ensureSubscribed(store._id, t4);
    assert.equal(r4?.ok, false);
    st = await MessageNotify.findOne({ storeId: store._id }).lean();
    assert.match(st?.error ?? "", /not allowed/);
    const t5 = fakeTrading();
    assert.equal(await ensureSubscribed(store._id, t5), null, "not again right away");
    await MessageNotify.updateOne({ storeId: store._id }, { $set: { lastAttemptAt: new Date(Date.now() - 25 * 3600_000) } });
    assert.equal((await ensureSubscribed(store._id, t5))?.ok, true, "retried after a day");
  } finally {
    Object.assign(env, saved);
  }
});

test("webhook: answers 200 at once, syncs the matching account, ignores forged ones", async () => {
  const store = await makeStore();
  const other = await makeStore(undefined, "another_seller");
  const synced: string[] = [];
  const real = notificationDeps.syncNow;
  notificationDeps.syncNow = async (id: string) => {
    synced.push(id);
  };
  const saved = { ...env.ebay };
  const post = (body: string) => fetch(`${base}/ebay/notifications`, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 50 && !ok(); i++) await sleep(20);
  };
  try {
    // no Dev ID configured: accepted as a hint (case-insensitive user id)
    env.ebay.devId = "";
    const r = await post(envelope({ recipient: SELLER.toLowerCase() }));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "OK");
    await until(() => synced.length > 0);
    assert.deepEqual(synced, [String(store._id)], "only the account it was sent to");
    const st = await MessageNotify.findOne({ storeId: store._id }).lean();
    assert.equal(st?.notifications, 1);
    assert.equal(st?.lastEvent, "MyMessagesM2MMessage");
    assert.ok(st?.lastNotificationAt);
    assert.equal(await MessageNotify.countDocuments({ storeId: other._id }), 0);

    // Dev ID configured: a bad signature is ignored, a good one triggers a sync
    Object.assign(env.ebay, { devId: KEYS.devId, clientId: KEYS.appId, clientSecret: KEYS.certId });
    synced.length = 0;
    const forged = await post(envelope({ signature: "forged==" }));
    assert.equal(forged.status, 200, "still 200 so eBay doesn't retry it");
    await sleep(150);
    assert.deepEqual(synced, []);

    const timestamp = new Date().toISOString();
    await post(envelope({ timestamp, signature: expectedSignature(timestamp, KEYS.devId, KEYS.appId, KEYS.certId) }));
    await until(() => synced.length > 0);
    assert.deepEqual(synced, [String(store._id)]);

    // unknown account / garbage: fine, nothing happens
    synced.length = 0;
    Object.assign(env.ebay, { devId: "" });
    assert.equal((await post(envelope({ recipient: "nobody_here" }))).status, 200);
    assert.equal((await post("garbage")).status, 200);
    await sleep(150);
    assert.deepEqual(synced, []);
  } finally {
    notificationDeps.syncNow = real;
    Object.assign(env.ebay, saved);
  }
});

test("status API + turn on button", async () => {
  const reg = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `n${Date.now()}@x.test`, password: "password-123", name: "U" }),
  });
  const cookie = reg.headers.get("set-cookie")!.split(";")[0];
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  const store = await makeStore(me.user.id ?? me.user._id, "status_seller");
  const t = fakeTrading();
  const realTrading = deps.trading;
  deps.trading = () => t as any;
  const saved = { publicApiUrl: env.publicApiUrl };
  const req = (p: string, method = "GET") => fetch(`${base}/stores/${store._id}/messages${p}`, { method, headers: { cookie } });
  try {
    env.publicApiUrl = "https://api.example.com";
    let s = await (await req("/notifications")).json();
    assert.equal(s.enabled, false);
    assert.equal(s.url, "https://api.example.com/ebay/notifications");

    const on = await req("/notifications/enable", "POST");
    assert.equal(on.status, 200);
    assert.deepEqual(t.calls.map((c) => c.name), ["SetNotificationPreferences"]);
    s = await (await req("/notifications")).json();
    assert.equal(s.enabled, true);
    assert.equal(s.notifications, 0);

    // eBay refuses: the error is shown and the button reports it
    deps.trading = () => fakeTrading("Invalid delivery URL") as any;
    const bad = await req("/notifications/enable", "POST");
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error, /Invalid delivery URL/);
    s = await (await req("/notifications")).json();
    assert.equal(s.enabled, false);
    assert.match(s.error, /Invalid delivery URL/);
  } finally {
    deps.trading = realTrading;
    Object.assign(env, saved);
  }
});
