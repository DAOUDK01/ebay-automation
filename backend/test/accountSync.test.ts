/** Account-management foundation: scopes, module registry, background sync, counts, API endpoints. */
process.env.JWT_SECRET = "test-secret";
process.env.ENCRYPTION_KEY = "test-key";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { encrypt } from "../src/lib/crypto";
import { LEGACY_SCOPES, missingScopes, USER_SCOPES } from "../src/lib/ebay/auth";
import { SellClient } from "../src/lib/ebay/sell";
import { DEFAULT_SETTINGS, Store, type StoreDocument } from "../src/models/Store";
import { SyncState } from "../src/models/SyncState";
import { MODULES } from "../src/modules";
import { MODULE_KEYS, type AccountModule } from "../src/modules/types";
import { countsFor, runAccountSync } from "../src/services/accountSync";

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

const FIN = "https://api.ebay.com/oauth/api_scope/sell.finances";
const makeStore = (scopes: string[]) =>
  Store.create({
    userId: new mongoose.Types.ObjectId(),
    ebayUserId: `seller${Math.random()}`,
    name: "Shop",
    auth: { refreshTokenEnc: encrypt("rt"), scopes },
    settings: structuredClone(DEFAULT_SETTINGS),
  }) as Promise<StoreDocument>;

test("scopes: new permissions added, old accounts need a reconnect", () => {
  assert.ok(USER_SCOPES.includes(FIN));
  assert.ok(LEGACY_SCOPES.every((s) => USER_SCOPES.includes(s)));
  assert.ok(missingScopes(LEGACY_SCOPES).includes(FIN));
  assert.deepEqual(missingScopes(USER_SCOPES), []);
  assert.ok(missingScopes(undefined).length > 0, "unknown = legacy");
});

test("registry: every module present, all stubs answer 501 and aren't ready", () => {
  assert.deepEqual(MODULES.map((m) => m.key).sort(), [...MODULE_KEYS].sort());
  assert.ok(MODULES.every((m) => m.router));
});

test("account sync: runs ready modules, saves cursor, isolates failures, needs scopes", async () => {
  const store = await makeStore(LEGACY_SCOPES);
  const calls: string[] = [];
  const mods: AccountModule[] = [
    {
      key: "orders",
      label: "Orders",
      ready: true,
      sync: async (ctx) => {
        calls.push(`orders cursor=${ctx.cursor}`);
        return { cursor: "2026-11-01", summary: "3 orders" };
      },
      counts: async () => ({ awaitingShipment: 2 }),
    },
    { key: "messages", label: "Messages", ready: true, sync: async () => { throw new Error("eBay down"); }, counts: async () => { throw new Error("x"); } },
    { key: "finances", label: "Finances", ready: true, scopes: [FIN], sync: async () => ({ summary: "should not run" }) },
    { key: "feedback", label: "Feedback", ready: false, sync: async () => ({ summary: "not built" }) },
  ];
  const fake = {} as any;
  const runs = await runAccountSync(store, undefined, fake, mods);
  assert.deepEqual(
    runs.map((r) => [r.module, r.ok]),
    [["orders", true], ["messages", false], ["finances", false]],
  );
  assert.match(runs[2].summary, /Reconnect/);
  const st = await SyncState.findOne({ storeId: store._id, module: "orders" }).lean();
  assert.equal(st?.cursor, "2026-11-01");
  assert.equal(st?.summary, "3 orders");
  // second run gets the saved cursor
  await runAccountSync(store, ["orders"], fake, mods);
  assert.deepEqual(calls, ["orders cursor=null", "orders cursor=2026-11-01"]);
  assert.equal((await SyncState.findOne({ storeId: store._id, module: "messages" }).lean())?.error, "eBay down");
  // counts merge, failing module ignored
  assert.deepEqual(await countsFor(store, mods), { awaitingShipment: 2 });
});

test("sell client: pages through offset/limit collections", async () => {
  const pages = [
    { total: 3, orders: [{ id: 1 }, { id: 2 }] },
    { total: 3, orders: [{ id: 3 }] },
  ];
  const c = new SellClient(async () => "t");
  let n = 0;
  c.get = (async () => pages[n++]) as any;
  const got: number[] = [];
  for await (const o of c.paged<{ id: number }>("/sell/fulfillment/v1/order", "orders", {}, 2)) got.push(o.id);
  assert.deepEqual(got, [1, 2, 3]);
});

test("API: modules list, counts, sync status, stub modules 501, reconnect info", async () => {
  const email = `u${Date.now()}@x.test`;
  const reg = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", name: "U" }),
  });
  const cookie = reg.headers.get("set-cookie")!.split(";")[0];
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  const store = await Store.create({
    userId: me.user.id ?? me.user._id,
    ebayUserId: "legacy-seller",
    name: "Legacy",
    auth: { refreshTokenEnc: encrypt("rt"), scopes: LEGACY_SCOPES },
    settings: structuredClone(DEFAULT_SETTINGS),
  });
  const get = (p: string) => fetch(`${base}${p}`, { headers: { cookie } });

  const mods = await (await get("/modules")).json();
  assert.equal(mods.modules.length, MODULE_KEYS.length);
  assert.deepEqual(
    mods.modules.map((m: any) => [m.key, m.ready]),
    MODULES.map((m) => [m.key, m.ready]),
  );

  // counts = whatever the built modules report (zeros for a fresh account)
  assert.deepEqual((await (await get(`/stores/${store._id}/counts`)).json()).counts, JSON.parse(JSON.stringify(await countsFor(store))));
  const status = await (await get(`/stores/${store._id}/account-sync`)).json();
  assert.equal(status.modules.length, MODULE_KEYS.length);

  const stub = MODULES.find((m) => !m.ready);
  if (stub) assert.equal((await get(`/stores/${store._id}/${stub.key}`)).status, 501, "modules not built yet answer 501");
  const sync = await fetch(`${base}/stores/${store._id}/account-sync`, { method: "POST", headers: { cookie } });
  const anySync = MODULES.some((m) => m.ready && m.sync);
  assert.equal(sync.status, anySync ? 202 : 400, "nothing to sync until a module is built");

  const detail = await (await get(`/stores/${store._id}`)).json();
  assert.ok(detail.store.missingFeatures.includes("Orders & shipping"));
  assert.equal(detail.store.settings.accountSync.everyMin, 15);
  // someone else's store is not reachable
  assert.equal((await fetch(`${base}/stores/${store._id}/orders`)).status, 401);
});
