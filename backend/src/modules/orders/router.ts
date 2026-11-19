import { Router } from "express";
import { z } from "zod";
import { EbayApiError } from "../../lib/ebay/sell";
import { loadStore } from "../../middleware/auth";
import { HttpError, parseBody } from "../../middleware/error";
import { carrierCode, parseTrackingCsv, REFUND_REASONS, refundable } from "./ebay";
import { Order, type OrderStatus } from "./model";
import { addTracking, getClients, issueRefund, refreshOrder } from "./service";

const router = Router({ mergeParams: true });

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** list tabs -> our statuses */
export const ORDER_FILTERS: Record<string, OrderStatus[] | null> = {
  awaiting: ["awaiting_shipment"],
  shipped: ["shipped"],
  cancelled: ["cancelled", "refunded"],
  unpaid: ["awaiting_payment"],
  all: null,
};

/** eBay errors become readable 4xx/502s instead of 500s. */
function ebayFail(e: any, what: string): never {
  if (e instanceof HttpError) throw e;
  if (e?.status && e.status < 500 && !(e instanceof EbayApiError)) throw new HttpError(e.status, e.message);
  if (e instanceof EbayApiError) throw new HttpError(e.status >= 400 && e.status < 500 ? 400 : 502, `${what}: ${e.message}`);
  throw new HttpError(502, `${what}: ${e?.message ?? e}`);
}

const LIST_FIELDS = "-raw";

router.get("/", async (req, res) => {
  const store = await loadStore(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
  const status = String(req.query.status ?? "all");
  const q = String(req.query.q ?? "").trim();
  const filter: Record<string, unknown> = { storeId: store._id };
  const statuses = ORDER_FILTERS[status];
  if (statuses) filter.status = { $in: statuses };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { orderId: q },
      { legacyOrderId: q },
      { "buyer.username": rx },
      { "buyer.name": rx },
      { "shipTo.name": rx },
      { "lineItems.title": rx },
      { "lineItems.sku": q },
      { "lineItems.itemId": q },
      { "fulfillments.trackingNumber": q.toUpperCase() },
    ];
  }
  const sort: Record<string, 1 | -1> = req.query.sort === "shipBy" ? { shipByDate: 1, creationDate: 1 } : { creationDate: -1 };
  const [items, total, tabs] = await Promise.all([
    Order.find(filter).select(LIST_FIELDS).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Order.countDocuments(filter),
    Order.aggregate([{ $match: { storeId: store._id } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const by = Object.fromEntries(tabs.map((t: any) => [t._id, t.n]));
  const tabCounts = Object.fromEntries(
    Object.entries(ORDER_FILTERS).map(([k, st]) => [k, st ? st.reduce((s, x) => s + (by[x] ?? 0), 0) : tabs.reduce((s: number, t: any) => s + t.n, 0)]),
  );
  res.json({ items, total, page, pageSize, tabs: tabCounts });
});

/** Several orders at once, e.g. for printing packing slips (?ids=a,b,c). */
router.get("/batch", async (req, res) => {
  const store = await loadStore(req);
  const ids = String(req.query.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  const orders = await Order.find({ storeId: store._id, orderId: { $in: ids } }).select(LIST_FIELDS).lean();
  orders.sort((a, b) => ids.indexOf(a.orderId) - ids.indexOf(b.orderId));
  res.json({ orders });
});

const bulkSchema = z.object({ csv: z.string().min(1).max(500_000), dryRun: z.boolean().optional() });

/**
 * Bulk tracking from CSV (orderId, carrier, tracking). dryRun = parse + match only (the UI shows that,
 * then asks for confirmation before the real upload). Orders are uploaded one at a time.
 */
router.post("/bulk-tracking", async (req, res) => {
  const store = await loadStore(req);
  const body = parseBody(bulkSchema, req.body);
  const { rows, errors } = parseTrackingCsv(body.csv);
  if (rows.length > 500) throw new HttpError(400, "At most 500 rows per upload");
  const ids = rows.map((r) => r.orderId);
  const orders = await Order.find({ storeId: store._id, $or: [{ orderId: { $in: ids } }, { legacyOrderId: { $in: ids } }] })
    .select("orderId legacyOrderId status buyer.username lineItems.title fulfillments.trackingNumber")
    .lean();
  const find = (id: string) => orders.find((o) => o.orderId === id || o.legacyOrderId === id);
  const plan = rows.map((r) => {
    const o = find(r.orderId);
    const problem = !o
      ? "Order not found (sync orders first?)"
      : o.status === "cancelled"
        ? "Order was cancelled"
        : o.fulfillments.some((f) => f.trackingNumber === r.trackingNumber.toUpperCase())
          ? "Tracking already uploaded"
          : "";
    return {
      line: r.line,
      input: r.orderId,
      orderId: o?.orderId ?? "",
      buyer: o?.buyer?.username ?? "",
      title: o?.lineItems?.[0]?.title ?? "",
      carrier: carrierCode(r.carrier),
      trackingNumber: r.trackingNumber.toUpperCase(),
      problem,
      ok: !problem,
      error: "",
    };
  });
  if (body.dryRun) return res.json({ rows: plan, errors });

  const clients = getClients(store);
  let uploaded = 0;
  for (const p of plan) {
    if (!p.ok) continue;
    try {
      await addTracking(store, p.orderId, { carrier: p.carrier, trackingNumber: p.trackingNumber }, clients);
      uploaded++;
    } catch (e: any) {
      p.ok = false;
      p.error = String(e?.message ?? e).slice(0, 300);
    }
  }
  res.json({ rows: plan, errors, uploaded });
});

router.get("/:orderId", async (req, res) => {
  const store = await loadStore(req);
  const order = await Order.findOne({ storeId: store._id, orderId: req.params.orderId }).lean();
  if (!order) throw new HttpError(404, "Order not found");
  res.json({ order, refundable: refundable(order as any) });
});

/** Re-read this order from eBay. */
router.post("/:orderId/refresh", async (req, res) => {
  const store = await loadStore(req);
  if (!(await Order.exists({ storeId: store._id, orderId: req.params.orderId }))) throw new HttpError(404, "Order not found");
  try {
    const order = await refreshOrder(store, String(req.params.orderId));
    res.json({ order });
  } catch (e) {
    ebayFail(e, "Couldn't refresh the order from eBay");
  }
});

const trackingSchema = z.object({
  carrier: z.string().trim().min(1).max(60),
  trackingNumber: z.string().trim().min(1).max(60),
  shippedDate: z.string().max(40).optional(),
  lineItems: z.array(z.object({ lineItemId: z.string().max(40), quantity: z.number().int().min(1).max(10000) })).max(200).optional(),
});

router.post("/:orderId/tracking", async (req, res) => {
  const store = await loadStore(req);
  const body = parseBody(trackingSchema, req.body);
  try {
    const order = await addTracking(store, String(req.params.orderId), body);
    res.json({ order });
  } catch (e) {
    ebayFail(e, "eBay rejected the tracking number");
  }
});

const refundSchema = z.object({
  kind: z.enum(["full", "partial"]),
  amount: z.number().positive().optional(),
  reason: z.enum(REFUND_REASONS),
  comment: z.string().max(100).optional(),
});

router.post("/:orderId/refund", async (req, res) => {
  const store = await loadStore(req);
  const body = parseBody(refundSchema, req.body);
  if (body.kind === "partial" && !body.amount) throw new HttpError(400, "Enter the amount to refund");
  try {
    res.json(await issueRefund(store, String(req.params.orderId), body));
  } catch (e) {
    ebayFail(e, "eBay rejected the refund");
  }
});

export default router;
