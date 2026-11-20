"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Alert, Badge, Empty, Pagination, Spinner, Stat, Toggle, cx } from "@/components/ui";
import { fetcher, money } from "@/lib/api";
import type { ProfitPage } from "@/lib/finances";

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Profit per order = sale total - eBay fees - shipping labels - refunds - your cost x quantity. */
export function ProfitTable({ storeId }: { storeId: string }) {
  const [days, setDays] = useState(90);
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState(1);
  const from = iso(new Date(Date.now() - days * 86_400_000));
  const { data, error } = useSWR<ProfitPage>(`/stores/${storeId}/finances/profit?from=${from}&page=${page}&missing=${missing ? 1 : 0}`, fetcher);
  const cur = data?.currency ?? "USD";
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => (setDays(r.days), setPage(1))}
              className={cx("rounded px-3 py-1 text-sm", days === r.days ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50")}
            >
              {r.label}
            </button>
          ))}
        </div>
        <Toggle checked={missing} onChange={(v) => (setMissing(v), setPage(1))} label="Only orders missing a cost" />
      </div>

      {error && <Alert>{error.message}</Alert>}
      {!data ? (
        <div className="flex justify-center py-10 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Orders" value={t!.orders} hint={t!.missingCost ? `${t!.missingCost} without a cost` : "All have costs"} />
            <Stat label="Sales" value={money(t!.saleTotal, cur)} hint="Before eBay fees" />
            <Stat label="eBay fees" value={money(t!.fees, cur)} hint="Final value + ad fees" />
            <Stat label="Labels & refunds" value={money(t!.shippingLabels + t!.refunds, cur)} hint={`${money(t!.shippingLabels, cur)} labels`} />
            <Stat
              label="Profit"
              value={<span className={t!.profit < 0 ? "text-rose-600" : "text-emerald-700"}>{money(t!.profit, cur)}</span>}
              hint={`after ${money(t!.itemCost, cur)} item costs`}
            />
          </div>
          {t!.missingCost > 0 && (
            <Alert kind="warning">
              {t!.missingCost} order{t!.missingCost === 1 ? " has" : "s have"} an item with no cost entered, so profit is overstated.{" "}
              <Link href={`/stores/${storeId}/listings`} className="font-medium underline">
                Enter costs on Listings
              </Link>
              .
            </Alert>
          )}
          {!data.items.length ? (
            <Empty title="No orders in this period">Sales appear here after Finances syncs from eBay.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Order</th>
                    <th className="py-2 pr-3">Items</th>
                    <th className="py-2 pr-3 text-right">Sale</th>
                    <th className="py-2 pr-3 text-right">Fees</th>
                    <th className="py-2 pr-3 text-right">Label</th>
                    <th className="py-2 pr-3 text-right">Refunds</th>
                    <th className="py-2 pr-3 text-right">Cost</th>
                    <th className="py-2 text-right">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((o) => (
                    <tr key={o.orderId} className="align-top">
                      <td className="py-2 pr-3">
                        <div className="font-mono text-xs text-slate-700">{o.orderId}</div>
                        <div className="text-xs text-slate-500">
                          {new Date(o.date).toLocaleDateString()}
                          {o.buyer ? ` · ${o.buyer}` : ""}
                        </div>
                      </td>
                      <td className="max-w-xs py-2 pr-3">
                        {o.items.map((i, k) => (
                          <div key={k} className="truncate text-slate-700">
                            {i.quantity > 1 && <span className="font-medium">{i.quantity}× </span>}
                            {i.itemId ? (
                              <Link href={`/stores/${storeId}/listings/${i.itemId}`} className="hover:underline">
                                {i.title ?? i.itemId}
                              </Link>
                            ) : (
                              <span className="text-slate-400">Unknown item</span>
                            )}
                            <span className="ml-1 text-xs text-slate-500">{i.unitCost === null ? "" : `@ ${money(i.unitCost, o.currency)}`}</span>
                          </div>
                        ))}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(o.saleTotal, o.currency)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{money(o.fees, o.currency)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{o.shippingLabels ? money(o.shippingLabels, o.currency) : "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{o.refunds ? money(o.refunds, o.currency) : "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                        {o.missingCost ? <Badge color="yellow">No cost</Badge> : money(o.itemCost, o.currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        <div className={cx("font-semibold", o.profit < 0 ? "text-rose-600" : "text-slate-900")}>
                          {o.missingCost && <span title="Cost missing - profit is overstated">≤ </span>}
                          {money(o.profit, o.currency)}
                        </div>
                        {o.margin !== null && <div className="text-xs text-slate-500">{Math.round(o.margin * 100)}% margin</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </div>
          )}
          <p className="text-xs text-slate-500">
            Sale = what the buyer paid you before fees (sales tax eBay collects is excluded). Item cost = the cost you entered on Listings ×
            quantity; quantity comes from the order when this account allows order access, otherwise 1 per line.
          </p>
        </>
      )}
    </div>
  );
}
