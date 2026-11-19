import { Router } from "express";
import { z } from "zod";
import { withKg } from "../../lib/shipping";
import type { ShippingPolicy } from "../../lib/ebay/types";
import { loadStore } from "../../middleware/auth";
import { HttpError, parseBody } from "../../middleware/error";
import type { StoreDocument } from "../../models/Store";
import { Order } from "../orders/model";
import { getClients } from "../orders/service";
import { applyPolicyFix, listPolicyFixes } from "./policyFixes";

const router = Router({ mergeParams: true });

/** Awaiting-shipment queue: oldest ship-by date first; overdue = ship-by date passed. */
router.get("/queue", async (req, res) => {
  const store = await loadStore(req);
  const orders = await Order.find({ storeId: store._id, status: "awaiting_shipment" })
    .select("-raw")
    .sort({ shipByDate: 1, creationDate: 1 })
    .limit(500)
    .lean();
  const now = Date.now();
  const dayEnd = now + 24 * 3600_000;
  const items = orders.map((o) => {
    const t = o.shipByDate ? new Date(o.shipByDate).getTime() : null;
    return { ...o, overdue: t !== null && t < now, dueSoon: t !== null && t >= now && t < dayEnd };
  });
  res.json({
    items,
    overdue: items.filter((i) => i.overdue).length,
    dueToday: items.filter((i) => i.dueSoon).length,
  });
});

async function livePolicies(store: StoreDocument): Promise<ShippingPolicy[]> {
  return withKg(await getClients(store).trading.getShippingPolicies());
}

/** Listings on the wrong shipping policy. ?live=1 re-checks against the store's current policies on eBay. */
router.get("/policy-fixes", async (req, res) => {
  const store = await loadStore(req);
  let policies: ShippingPolicy[] | undefined;
  let liveError = "";
  if (req.query.live === "1") {
    try {
      policies = await livePolicies(store);
    } catch (e: any) {
      liveError = `Couldn't load your shipping policies from eBay (${String(e?.message ?? e).slice(0, 200)}) - showing the saved analysis`;
    }
  }
  const items = await listPolicyFixes(store, policies);
  res.json({ items, live: Boolean(policies), liveError });
});

const applySchema = z.object({ policyId: z.string().min(1).max(40) });

/** Switch ONE listing to the suggested policy. The UI confirms, then calls this per listing. */
router.post("/policy-fixes/:itemId/apply", async (req, res) => {
  const store = await loadStore(req);
  const { policyId } = parseBody(applySchema, req.body);
  const itemId = String(req.params.itemId);
  const fix = (await listPolicyFixes(store)).find((f) => f.itemId === itemId);
  if (!fix) throw new HttpError(404, "This listing has no pending policy fix");
  if (fix.suggested.id !== policyId) throw new HttpError(409, "The suggestion changed - reload the list");
  try {
    const r = await applyPolicyFix(store, getClients(store).trading, fix);
    res.json({ ok: true, ...r, policy: fix.suggested });
  } catch (e: any) {
    throw new HttpError(502, `eBay rejected the change: ${String(e?.message ?? e).slice(0, 300)}`);
  }
});

export default router;
