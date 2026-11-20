/** Sales analytics from synced orders (orders module) - pure maths, no database. */

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const toRange = (v: unknown): RangeDays => (RANGES.includes(Number(v) as RangeDays) ? (Number(v) as RangeDays) : 30);

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** The last `days` days including today (UTC), and the same length just before it. */
export function salesPeriods(days: number, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const start = new Date(end.getTime() - days * DAY + 1);
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - days * DAY + 1);
  return { start, end, prevStart, prevEnd };
}

/** % change, null when there's nothing to compare with. */
export const change = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? null : 0);

export interface OrderForSales {
  orderId: string;
  status: string;
  creationDate: Date | string;
  totals?: { total?: number | null; currency?: string | null } | null;
  refunds?: { amount?: number | null }[] | null;
  lineItems?: { itemId?: string | null; title?: string | null; qty?: number | null; total?: number | null; image?: string | null }[] | null;
}

export interface SalesTotals {
  orders: number;
  revenue: number;
  units: number;
  avgOrderValue: number;
  cancelled: number;
  refunded: number;
  refundAmount: number;
}

const emptyTotals = (): SalesTotals => ({ orders: 0, revenue: 0, units: 0, avgOrderValue: 0, cancelled: 0, refunded: 0, refundAmount: 0 });

function addOrder(t: SalesTotals, o: OrderForSales) {
  if (o.status === "cancelled") {
    t.cancelled++;
    return;
  }
  t.orders++;
  t.revenue += o.totals?.total ?? 0;
  t.units += (o.lineItems ?? []).reduce((s, l) => s + (l.qty ?? 1), 0);
  const refund = (o.refunds ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
  if (refund > 0 || o.status === "refunded") t.refunded++;
  t.refundAmount += refund;
}

const finish = (t: SalesTotals): SalesTotals => ({
  ...t,
  revenue: round2(t.revenue),
  refundAmount: round2(t.refundAmount),
  avgOrderValue: t.orders ? round2(t.revenue / t.orders) : 0,
});

/**
 * Revenue, orders, units, AOV (cancelled orders excluded), a value for every day, best sellers and
 * sales by weekday for the current period, plus the previous period's totals for comparison.
 */
export function salesReport(orders: OrderForSales[], days: number, now = new Date()) {
  const p = salesPeriods(days, now);
  const cur = emptyTotals();
  const prev = emptyTotals();
  const byDay = new Map<string, { revenue: number; orders: number }>();
  for (let d = p.start.getTime(); d <= p.end.getTime(); d += DAY) byDay.set(dayKey(new Date(d)), { revenue: 0, orders: 0 });
  const items = new Map<string, { itemId: string; title: string; image: string; units: number; revenue: number; orders: number }>();
  const weekday = Array.from({ length: 7 }, () => ({ orders: 0, revenue: 0 }));

  for (const o of orders) {
    const at = new Date(o.creationDate);
    if (at >= p.prevStart && at <= p.prevEnd) addOrder(prev, o);
    if (at < p.start || at > p.end) continue;
    addOrder(cur, o);
    if (o.status === "cancelled") continue;
    const total = o.totals?.total ?? 0;
    const d = byDay.get(dayKey(at));
    if (d) {
      d.revenue += total;
      d.orders++;
    }
    weekday[at.getUTCDay()].orders++;
    weekday[at.getUTCDay()].revenue += total;
    for (const l of o.lineItems ?? []) {
      const key = l.itemId || l.title || "?";
      const it = items.get(key) ?? { itemId: l.itemId ?? "", title: l.title ?? "", image: l.image ?? "", units: 0, revenue: 0, orders: 0 };
      it.units += l.qty ?? 1;
      it.revenue += l.total ?? 0;
      it.orders++;
      items.set(key, it);
    }
  }

  const c = finish(cur);
  const pr = finish(prev);
  return {
    range: { days, start: p.start.toISOString(), end: p.end.toISOString() },
    currency: orders.find((o) => o.totals?.currency)?.totals?.currency ?? "USD",
    totals: c,
    previous: pr,
    change: {
      revenue: change(c.revenue, pr.revenue),
      orders: change(c.orders, pr.orders),
      units: change(c.units, pr.units),
      avgOrderValue: change(c.avgOrderValue, pr.avgOrderValue),
    },
    days: [...byDay].map(([day, v]) => ({ day, revenue: round2(v.revenue), orders: v.orders })),
    topItems: [...items.values()]
      .map((i) => ({ ...i, revenue: round2(i.revenue) }))
      .sort((a, b) => b.revenue - a.revenue || b.units - a.units)
      .slice(0, 10),
    weekday: weekday.map((w, i) => ({ day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i], orders: w.orders, revenue: round2(w.revenue) })),
  };
}
