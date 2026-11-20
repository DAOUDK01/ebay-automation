"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { AccountHealthCard } from "@/components/analytics/AccountHealthCard";
import { LineChart } from "@/components/analytics/LineChart";
import { NoSalesList, TopListingsTable } from "@/components/analytics/ListingTrafficTable";
import { Funnel, Kpi, RangeToggle, TopSellers, WeekdayBars } from "@/components/analytics/Panels";
import { SyncStatus } from "@/components/finances/SyncStatus";
import { Alert, Card, Empty, Spinner } from "@/components/ui";
import { fetcher, money } from "@/lib/api";
import type { AnalyticsOverview, ListingTrafficResponse, RangeDays, SalesReport } from "@/lib/analytics";

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(2)}%`);

export default function AnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<RangeDays>(30);
  const [sort, setSort] = useState("views");
  const { data, error, mutate } = useSWR<AnalyticsOverview>(`/stores/${id}/analytics/overview?days=${range}`, fetcher, { keepPreviousData: true });
  const sales = useSWR<SalesReport>(`/stores/${id}/analytics/sales?days=${range}`, fetcher, { keepPreviousData: true });
  const listings = useSWR<ListingTrafficResponse>(`/stores/${id}/analytics/listings?sort=${sort}`, fetcher);

  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Spinner />
      </div>
    );
  const t = data.totals;
  const s = sales.data;
  const cur = s?.currency ?? "USD";
  const period = `in ${range} days`;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeToggle value={range} onChange={setRange} />
        <span className="text-xs text-slate-500">Compared with the {range} days before</span>
      </div>
      <SyncStatus storeId={id} module="analytics" sync={data.sync} onQueued={() => setTimeout(() => mutate(), 30_000)} />

      {/* ---------------- sales (orders) */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Sales</h2>
        {!s ? (
          <div className="flex justify-center py-8 text-slate-400">
            <Spinner />
          </div>
        ) : !s.hasOrders ? (
          <Empty title="No orders synced yet">Sales numbers appear after the Orders module syncs (Settings → Account sync).</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Kpi label="Revenue" value={money(s.totals.revenue, cur)} delta={s.change.revenue} hint={`was ${money(s.previous.revenue, cur)}`} />
              <Kpi label="Orders" value={s.totals.orders.toLocaleString()} delta={s.change.orders} hint={`${s.totals.cancelled} cancelled`} />
              <Kpi label="Units sold" value={s.totals.units.toLocaleString()} delta={s.change.units} />
              <Kpi
                label="Avg order value"
                value={money(s.totals.avgOrderValue, cur)}
                delta={s.change.avgOrderValue}
                hint={s.totals.refunded ? `${s.totals.refunded} refunded (${money(s.totals.refundAmount, cur)})` : "No refunds"}
              />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <LineChart
                title="Revenue"
                total={money(s.totals.revenue, cur)}
                periodLabel={period}
                colorClass="text-emerald-600"
                format={(n) => money(n, cur)}
                points={s.days.map((d) => ({ day: d.day, value: d.revenue }))}
              />
              <LineChart title="Orders" total={s.totals.orders.toLocaleString()} periodLabel={period} points={s.days.map((d) => ({ day: d.day, value: d.orders }))} />
            </div>
            <div className="grid gap-6 xl:grid-cols-5">
              <Card title="Best sellers" className="min-w-0 xl:col-span-3">
                {s.topItems.length ? <TopSellers storeId={id} rows={s.topItems} currency={cur} /> : <Empty title="No sales in this period" />}
              </Card>
              <Card title="Orders by weekday" className="min-w-0 xl:col-span-2">
                <WeekdayBars rows={s.weekday} currency={cur} />
              </Card>
            </div>
          </>
        )}
      </section>

      {/* ---------------- traffic */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Traffic</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Kpi label="Impressions" value={t.impressions.toLocaleString()} delta={data.change?.impressions} hint="Search & browse" />
          <Kpi label="Views" value={t.views.toLocaleString()} delta={data.change?.views} hint="Listing page views" />
          <Kpi label="Click-through" value={pct(t.ctr)} hint={data.previous ? `was ${pct(data.previous.ctr)}` : "Views ÷ impressions"} />
          <Kpi label="Sales" value={t.transactions.toLocaleString()} delta={data.change?.transactions} hint="eBay transactions" />
          <Kpi label="Conversion" value={pct(t.conversion)} hint={data.previous ? `was ${pct(data.previous.conversion)}` : "Sales ÷ views"} />
        </div>
        {!data.hasData ? (
          <Empty title="No traffic data yet">eBay&apos;s traffic report loads with the next Analytics refresh.</Empty>
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            <LineChart title="Impressions" total={t.impressions.toLocaleString()} periodLabel={period} points={data.days.map((d) => ({ day: d.day, value: d.impressions }))} />
            <LineChart title="Views" total={t.views.toLocaleString()} periodLabel={period} points={data.days.map((d) => ({ day: d.day, value: d.views }))} />
            <Card title="Funnel">
              <Funnel t={t} />
            </Card>
          </div>
        )}
      </section>

      {/* ---------------- listings + health */}
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="min-w-0 space-y-6 xl:col-span-3">
          <Card
            title="Top listings (30 days)"
            actions={
              <select className="input w-40 py-1 text-xs" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort top listings">
                <option value="views">Most views</option>
                <option value="impressions">Most impressions</option>
                <option value="sales">Most sales</option>
              </select>
            }
          >
            {!listings.data ? (
              <div className="flex justify-center py-8 text-slate-400">
                <Spinner />
              </div>
            ) : listings.data.top.length ? (
              <TopListingsTable storeId={id} rows={listings.data.top} />
            ) : (
              <Empty title="No listing traffic yet" />
            )}
          </Card>
          <Card title="Views but no sales">
            {listings.data && (
              <p className="mb-2 text-sm text-slate-500">
                {listings.data.noSalesMinViews}+ views in 30 days and nothing sold - usually the price, photos or title. Optimize them to get a
                fresh title, price check and item specifics.
              </p>
            )}
            {listings.data?.noSales.length ? (
              <NoSalesList storeId={id} rows={listings.data.noSales} />
            ) : (
              listings.data && <Empty title="Nothing here - every well-viewed listing is selling" />
            )}
          </Card>
        </div>
        <div className="xl:col-span-2">
          <AccountHealthCard data={data} />
        </div>
      </div>
    </div>
  );
}
