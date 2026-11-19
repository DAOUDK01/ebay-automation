/** Orders: sync from eBay, refresh one order, upload tracking, issue refunds, counts. */
import { clientsFor, type SellClient, type StoreClients } from "../../lib/ebay/sell";
import { Listing } from "../../models/Listing";
import { resolveSettings, type StoreDocument } from "../../models/Store";
import type { Counts, SyncContext, SyncResult } from "../types";
import { buildRefundPayload, buildTrackingPayload, FULFILLMENT, normalizeOrder, type EbayFulfillment, type RefundInput, type TrackingInput } from "./ebay";
import { Order } from "./model";

/** API clients for a store. Swappable so tests can run without eBay (setClientsFactory). */
let factory: (store: StoreDocument) => StoreClients = clientsFor;
export const getClients = (store: StoreDocument) => factory(store);
export function setClientsFactory(f: ((store: StoreDocument) => StoreClients) | null) {
  factory = f ?? clientsFor;
}

/** First sync looks back this far. */
export const FIRST_SYNC_DAYS = 90;

async function imagesFor(storeId: StoreDocument["_id"], orders: any[]): Promise<Record<string, string>> {
  const ids = [...new Set(orders.flatMap((o) => (o?.lineItems ?? []).map((l: any) => String(l.legacyItemId ?? ""))).filter(Boolean))];
  if (!ids.length) return {};
  const rows = await Listing.find({ storeId, itemId: { $in: ids } }, { itemId: 1, imageUrl: 1 }).lean();
  return Object.fromEntries(rows.map((r) => [r.itemId, r.imageUrl ?? ""]));
}

async function fulfillmentsFor(sell: SellClient, o: any): Promise<EbayFulfillment[] | undefined> {
  if (!o?.fulfillmentHrefs?.length) return [];
  try {
    const r = await sell.get(`${FULFILLMENT}/order/${encodeURIComponent(o.orderId)}/shipping_fulfillment`);
    return r?.fulfillments ?? [];
  } catch {
    return undefined; // keep what we had
  }
}

/** Save eBay orders (upsert). Returns how many were new or changed. */
export async function upsertOrders(store: StoreDocument, sell: SellClient, orders: any[]): Promise<number> {
  if (!orders.length) return 0;
  const images = await imagesFor(store._id, orders);
  const existing = await Order.find({ storeId: store._id, orderId: { $in: orders.map((o) => o.orderId) } }, { orderId: 1, lastModifiedDate: 1 }).lean();
  const seen = new Map(existing.map((e) => [e.orderId, e.lastModifiedDate?.getTime()]));
  let changed = 0;
  const ops = [];
  for (const o of orders) {
    const prev = seen.get(o.orderId);
    const mod = o.lastModifiedDate ? new Date(o.lastModifiedDate).getTime() : 0;
    if (prev === undefined || prev !== mod) changed++;
    const fulfillments = prev !== undefined && prev === mod ? undefined : await fulfillmentsFor(sell, o);
    ops.push({
      updateOne: {
        filter: { storeId: store._id, orderId: String(o.orderId) },
        update: { $set: { storeId: store._id, ...normalizeOrder(o, images, fulfillments) } },
        upsert: true,
      },
    });
  }
  await Order.bulkWrite(ops);
  return changed;
}

/** Incremental getOrders by last-modified date. Cursor = newest lastModifiedDate seen (ISO string). */
export async function syncOrders(ctx: SyncContext): Promise<SyncResult> {
  const since = ctx.cursor ? new Date(ctx.cursor) : new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000);
  const filter = `lastmodifieddate:[${since.toISOString()}..]`;
  let newest = ctx.cursor ? new Date(ctx.cursor).getTime() : 0;
  let changed = 0;
  let buf: any[] = [];
  for await (const o of ctx.clients.sell.paged<any>(`${FULFILLMENT}/order`, "orders", { filter }, 200)) {
    buf.push(o);
    const t = o?.lastModifiedDate ? new Date(o.lastModifiedDate).getTime() : 0;
    if (t > newest) newest = t;
    if (buf.length >= 200) {
      changed += await upsertOrders(ctx.store, ctx.clients.sell, buf);
      buf = [];
    }
  }
  changed += await upsertOrders(ctx.store, ctx.clients.sell, buf);
  ctx.log(`${changed} orders updated since ${since.toISOString()}`);
  return {
    cursor: newest ? new Date(newest).toISOString() : (ctx.cursor ?? undefined),
    summary: changed ? `${changed} order${changed === 1 ? "" : "s"} updated` : "No order changes",
  };
}

/** Re-read one order (and its fulfillments) from eBay. */
export async function refreshOrder(store: StoreDocument, orderId: string, clients = getClients(store)) {
  const o = await clients.sell.get(`${FULFILLMENT}/order/${encodeURIComponent(orderId)}`);
  if (o?.orderId) {
    // force a fulfillment re-read: lastModifiedDate may not have moved yet
    await Order.updateOne({ storeId: store._id, orderId }, { $set: { lastModifiedDate: new Date(0) } });
    await upsertOrders(store, clients.sell, [o]);
  }
  return Order.findOne({ storeId: store._id, orderId }).lean();
}

/** Upload tracking for one order (user click only). Returns the refreshed order. */
export async function addTracking(store: StoreDocument, orderId: string, t: TrackingInput, clients = getClients(store)) {
  const order = await Order.findOne({ storeId: store._id, orderId }).lean();
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (order.status === "cancelled") throw Object.assign(new Error("This order was cancelled"), { status: 400 });
  let body;
  try {
    body = buildTrackingPayload(order as any, t);
  } catch (e: any) {
    throw Object.assign(e, { status: 400 });
  }
  await clients.sell.post(`${FULFILLMENT}/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, body);
  // eBay accepted it; record locally even if the refresh below fails
  await Order.updateOne(
    { storeId: store._id, orderId },
    {
      $push: {
        fulfillments: {
          fulfillmentId: "",
          carrier: body.shippingCarrierCode,
          trackingNumber: body.trackingNumber,
          shippedDate: new Date(body.shippedDate),
          lineItems: body.lineItems.map((l) => ({ lineItemId: l.lineItemId, qty: l.quantity })),
        },
      },
    },
  );
  try {
    return await refreshOrder(store, orderId, clients);
  } catch {
    const all = new Set(order.lineItems.map((l) => l.lineItemId));
    const covered = body.lineItems.every((l) => all.has(l.lineItemId)) && body.lineItems.length === all.size;
    if (covered) await Order.updateOne({ storeId: store._id, orderId }, { $set: { status: "shipped" } });
    return Order.findOne({ storeId: store._id, orderId }).lean();
  }
}

/** Issue a refund (user click + confirm only). */
export async function issueRefund(store: StoreDocument, orderId: string, r: RefundInput, clients = getClients(store)) {
  const order = await Order.findOne({ storeId: store._id, orderId }).lean();
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  let body;
  try {
    body = buildRefundPayload(order as any, r);
  } catch (e: any) {
    throw Object.assign(e, { status: 400 });
  }
  const res = await clients.sell.post<{ refundId?: string; refundStatus?: string }>(
    `${FULFILLMENT}/order/${encodeURIComponent(orderId)}/issue_refund`,
    body,
  );
  await Order.updateOne(
    { storeId: store._id, orderId },
    {
      $push: {
        refunds: {
          refundId: res?.refundId ?? "",
          amount: Number(body.orderLevelRefundAmount.value),
          currency: body.orderLevelRefundAmount.currency,
          date: new Date(),
          status: res?.refundStatus ?? "PENDING",
          reason: r.reason,
        },
      },
    },
  );
  let order2 = null;
  try {
    order2 = await refreshOrder(store, orderId, clients);
    // eBay may not list a just-issued refund yet; keep ours visible
    if (order2 && res?.refundId && !order2.refunds.some((x) => x.refundId === res.refundId)) {
      await Order.updateOne(
        { storeId: store._id, orderId },
        { $push: { refunds: { refundId: res.refundId, amount: Number(body.orderLevelRefundAmount.value), currency: body.orderLevelRefundAmount.currency, date: new Date(), status: res.refundStatus ?? "PENDING", reason: r.reason } } },
      );
      order2 = await Order.findOne({ storeId: store._id, orderId }).lean();
    }
  } catch {
    order2 = await Order.findOne({ storeId: store._id, orderId }).lean();
  }
  return { refundId: res?.refundId ?? "", refundStatus: res?.refundStatus ?? "PENDING", order: order2 };
}

/** Midnight today in the store's time zone, as a Date. */
export function startOfToday(timeZone: string, now = new Date()): Date {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000; // tz offset in ms
    return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset);
  } catch {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

export async function orderCounts(store: StoreDocument): Promise<Counts> {
  const tz = resolveSettings(store.settings).activeHours.timezone || "UTC";
  const since = startOfToday(tz);
  const [awaitingShipment, today] = await Promise.all([
    Order.countDocuments({ storeId: store._id, status: "awaiting_shipment" }),
    Order.aggregate([
      { $match: { storeId: store._id, creationDate: { $gte: since }, status: { $ne: "cancelled" } } },
      { $group: { _id: "$totals.currency", n: { $sum: 1 }, total: { $sum: "$totals.total" } } },
      { $sort: { n: -1 } },
    ]),
  ]);
  const ordersToday = today.reduce((s: number, r: any) => s + r.n, 0);
  const main = today[0];
  let currency = main?._id as string | undefined;
  if (!currency) currency = ((await Order.findOne({ storeId: store._id }).select("totals.currency").lean()) as any)?.totals?.currency ?? "USD";
  return { awaitingShipment, ordersToday, salesToday: main ? Math.round(main.total * 100) / 100 : 0, currency };
}
