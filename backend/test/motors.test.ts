/** eBay Motors: category tree fallback + revising on the listing's own site. Network is mocked. */
process.env.EBAY_CLIENT_ID = "test-client";
process.env.EBAY_CLIENT_SECRET = "test-secret";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { RestClient } from "../src/lib/ebay/rest";
import { siteIdFor, TradingClient } from "../src/lib/ebay/trading";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("aspects: falls back to the eBay Motors tree on error 62005", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/oauth2/token")) return json({ access_token: "app-token", expires_in: 7200 });
    if (url.includes("get_default_category_tree_id")) {
      return json({ categoryTreeId: url.includes("EBAY_MOTORS_US") ? "100" : "0" });
    }
    if (url.includes("/category_tree/0/")) {
      return json(
        { errors: [{ errorId: 62005, message: "The specified category ID does not belong to specified category tree." }] },
        400,
      );
    }
    if (url.includes("/category_tree/100/")) {
      return json({
        aspects: [
          {
            localizedAspectName: "Placement on Vehicle",
            aspectConstraint: { aspectRequired: false, aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "MULTI" },
            aspectValues: [{ localizedValue: "Front" }, { localizedValue: "Rear" }],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const aspects = await new RestClient("EBAY_US").aspectsForCategory("179850");
  assert.equal(aspects.length, 1);
  assert.equal(aspects[0].name, "Placement on Vehicle");
  assert.deepEqual(aspects[0].values, ["Front", "Rear"]);
  assert.ok(calls.some((u) => u.includes("/category_tree/0/")), "tried the US tree first");
  assert.ok(calls.some((u) => u.includes("/category_tree/100/")), "then the Motors tree");
});

test("aspects: other errors are not swallowed", async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return json({ access_token: "app-token", expires_in: 7200 });
    if (url.includes("get_default_category_tree_id")) return json({ categoryTreeId: "0" });
    return json({ errors: [{ errorId: 62004, message: "Invalid category" }] }, 400);
  }) as typeof fetch;
  await assert.rejects(new RestClient("EBAY_US").aspectsForCategory("999999999"), /62004/);
});

test("revise goes to the listing's site (Motors = 100)", async () => {
  assert.equal(siteIdFor("eBayMotors"), 100);
  assert.equal(siteIdFor("US"), 0);
  assert.equal(siteIdFor(undefined, 3), 3);
  assert.equal(siteIdFor("SomethingNew", 0), 0);

  const sites: string[] = [];
  globalThis.fetch = (async (_input: any, init: any) => {
    sites.push(init.headers["X-EBAY-API-SITEID"]);
    return new Response(
      `<?xml version="1.0"?><ReviseFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack></ReviseFixedPriceItemResponse>`,
    );
  }) as typeof fetch;
  const t = new TradingClient(async () => "user-token", 0);
  await t.reviseItem("123", { title: "x" }, "eBayMotors");
  await t.reviseItem("456", { title: "y" });
  assert.deepEqual(sites, ["100", "0"]);
});
