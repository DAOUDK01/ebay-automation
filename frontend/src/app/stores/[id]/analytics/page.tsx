"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { AccountHealthCard } from "@/components/analytics/AccountHealthCard";
import { LineChart } from "@/components/analytics/LineChart";
import { NoSalesList, TopListingsTable } from "@/components/analytics/ListingTrafficTable";
import { SyncStatus } from "@/components/finances/SyncStatus";
import { Alert, Card, Empty, Spinner, Stat } from "@/components/ui";
import { fetcher } from "@/lib/api";
import type { AnalyticsOverview, ListingTrafficResponse } from "@/lib/analytics";

const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);

export default function AnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const [sort, setSort] = useState("views");
  const { data, error, mutate } = useSWR<AnalyticsOverview>(`/stores/${id}/analytics/overview`, fetcher);
  const listings = useSWR<ListingTrafficResponse>(`/stores/${id}/analytics/listings?sort=${sort}`, fetcher);

  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Spinner />
      </div>
    );
  const t = data.totals;

  return (
    <div className="space-y-6">
      <SyncStatus storeId={id} module="analytics" sync={data.sync} onQueued={() => setTimeout(() => mutate(), 30_000)} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Impressions" value={t.impressions.toLocaleString()} hint="Last 30 days" />
        <Stat label="Views" value={t.views.toLocaleString()} hint="Listing page views" />
        <Stat label="Click-through" value={pct(t.ctr)} hint="Views ÷ impressions" />
        <Stat label="Sales" value={t.transactions.toLocaleString()} hint="Transactions" />
        <Stat label="Conversion" value={pct(t.conversion)} hint="Sales ÷ views" />
      </div>

      {!data.hasData ? (
        <Empty title="No traffic data yet">eBay&apos;s traffic report loads with the next Analytics refresh.</Empty>
      ) : (
        <div className="grid gap-4 2xl:grid-cols-3">
          <LineChart title="Impressions" total={t.impressions.toLocaleString()} points={data.days.map((d) => ({ day: d.day, value: d.impressions }))} />
          <LineChart title="Views" total={t.views.toLocaleString()} points={data.days.map((d) => ({ day: d.day, value: d.views }))} />
          <LineChart title="Sales" total={t.transactions.toLocaleString()} points={data.days.map((d) => ({ day: d.day, value: d.transactions }))} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Card
            title="Top listings"
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
