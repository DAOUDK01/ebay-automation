/** /api/stores/:storeId/analytics - traffic, top listings and account health from the synced snapshots. */
import { Router } from "express";
import { loadStore } from "../../middleware/auth";
import { Listing } from "../../models/Listing";
import { SyncState } from "../../models/SyncState";
import { EBAY_THRESHOLDS, trafficWindow } from "./logic";
import { AccountHealth, ListingTraffic, TrafficDay } from "./models";
import { Order } from "../orders/model";
import { change, salesPeriods, salesReport, toRange } from "./sales";

const router = Router({ mergeParams: true });

/** Views at or above this with zero sales = worth optimizing. */
export const NO_SALES_MIN_VIEWS = 10;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 100 : null);

/** ?days=7|30|90 - traffic for the range (ending yesterday: eBay's report lags a day) + the range before it. */
router.get("/overview", async (req, res) => {
  const store = await loadStore(req);
  const range = toRange(req.query.days);
  const { start, end } = trafficWindow(range);
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (range - 1) * 86_400_000);
  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  const [rows, prevRows, health, state] = await Promise.all([
    TrafficDay.find({ storeId: store._id, day: { $gte: from, $lte: to } }).sort({ day: 1 }).lean(),
    TrafficDay.find({ storeId: store._id, day: { $gte: prevStart.toISOString().slice(0, 10), $lte: prevEnd.toISOString().slice(0, 10) } }).lean(),
    AccountHealth.findOne({ storeId: store._id }).lean(),
    SyncState.findOne({ storeId: store._id, module: "analytics" }).lean(),
  ]);
  // every day in the window, zeros where eBay had nothing
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days: { day: string; impressions: number; views: number; transactions: number }[] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key);
    days.push({ day: key, impressions: r?.impressions ?? 0, views: r?.views ?? 0, transactions: r?.transactions ?? 0 });
  }
  const sum = (k: "impressions" | "views" | "transactions") => days.reduce((s, d) => s + d[k], 0);
  const totals = { impressions: sum("impressions"), views: sum("views"), transactions: sum("transactions") };
  const psum = (k: "impressions" | "views" | "transactions") => prevRows.reduce((s, d) => s + (d[k] ?? 0), 0);
  const prev = { impressions: psum("impressions"), views: psum("views"), transactions: psum("transactions") };
  res.json({
    hasData: rows.length > 0,
    range: { days: range, start: from, end: to },
    days,
    totals: { ...totals, ctr: pct(totals.views, totals.impressions), conversion: pct(totals.transactions, totals.views) },
    previous: prevRows.length ? { ...prev, ctr: pct(prev.views, prev.impressions), conversion: pct(prev.transactions, prev.views) } : null,
    change: prevRows.length
      ? { impressions: change(totals.impressions, prev.impressions), views: change(totals.views, prev.views), transactions: change(totals.transactions, prev.transactions) }
      : null,
    health,
    thresholds: EBAY_THRESHOLDS,
    sync: state ? { lastSuccessAt: state.lastSuccessAt, lastRunAt: state.lastRunAt, summary: state.summary, error: state.error } : null,
  });
});

/** ?days=7|30|90 - revenue, orders, units, AOV, best sellers and weekday split from synced orders. */
router.get("/sales", async (req, res) => {
  const store = await loadStore(req);
  const range = toRange(req.query.days);
  const { prevStart } = salesPeriods(range);
  const orders = await Order.find(
    { storeId: store._id, creationDate: { $gte: prevStart } },
    { orderId: 1, status: 1, creationDate: 1, totals: 1, refunds: 1, lineItems: 1 },
  ).lean();
  res.json({ hasOrders: orders.length > 0, ...salesReport(orders as any, range) });
});

/** Per-listing traffic joined with the listing; `noSales` = plenty of views, no sales. */
router.get("/listings", async (req, res) => {
  const store = await loadStore(req);
  const sorts: Record<string, string> = { impressions: "impressions", views: "views", sales: "transactions" };
  const sortKey = sorts[String(req.query.sort ?? "views")] ?? "views";
  const sort: Record<string, -1> = { [sortKey]: -1 };
  sort.views = -1;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
  const [top, noSales] = await Promise.all([
    ListingTraffic.find({ storeId: store._id }).sort(sort).limit(limit).lean(),
    ListingTraffic.find({ storeId: store._id, transactions: 0, views: { $gte: NO_SALES_MIN_VIEWS } }).sort({ views: -1 }).limit(50).lean(),
  ]);
  const ids = [...new Set([...top, ...noSales].map((t) => t.itemId))];
  const listings = await Listing.find({ storeId: store._id, itemId: { $in: ids } }, { itemId: 1, title: 1, price: 1, imageUrl: 1, active: 1, lastProcessedAt: 1 }).lean();
  const byId = new Map(listings.map((l) => [l.itemId, l]));
  const join = (t: (typeof top)[number]) => {
    const l = byId.get(t.itemId);
    return {
      itemId: t.itemId,
      title: l?.title ?? null,
      price: l?.price ?? null,
      imageUrl: l?.imageUrl ?? null,
      active: l?.active ?? null,
      lastOptimizedAt: l?.lastProcessedAt ?? null,
      impressions: t.impressions,
      views: t.views,
      transactions: t.transactions,
      ctr: pct(t.views, t.impressions),
      conversion: pct(t.transactions, t.views),
    };
  };
  res.json({
    top: top.map(join),
    noSales: noSales.map(join),
    noSalesMinViews: NO_SALES_MIN_VIEWS,
    period: top[0] ? { start: top[0].periodStart, end: top[0].periodEnd } : null,
  });
});

export default router;
