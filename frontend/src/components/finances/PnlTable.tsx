"use client";
import useSWR from "swr";
import { Alert, Badge, Empty, Spinner, cx } from "@/components/ui";
import { fetcher, money } from "@/lib/api";
import type { MonthPnl } from "@/lib/finances";

const monthName = (m: string) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric" });

/** Monthly profit & loss: sales, costs, net - newest month first, with a total row. */
export function PnlTable({ storeId }: { storeId: string }) {
  const { data, error } = useSWR<{ months: MonthPnl[]; currency: string }>(`/stores/${storeId}/finances/pnl?months=12`, fetcher);
  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-10 text-slate-400">
        <Spinner />
      </div>
    );
  if (!data.months.length) return <Empty title="No transactions in the last 12 months" />;
  const cur = data.currency;
  const keys = ["orders", "sales", "fees", "shippingLabels", "refunds", "credits", "costOfGoods", "net", "missingCostOrders"] as const;
  const total = Object.fromEntries(keys.map((k) => [k, data.months.reduce((s, m) => s + m[k], 0)])) as Record<(typeof keys)[number], number>;
  const maxAbs = Math.max(...data.months.map((m) => Math.abs(m.net)), 1);

  const row = (m: Omit<MonthPnl, "month">, label: string, isTotal = false) => (
    <tr key={label} className={cx(isTotal && "border-t-2 border-slate-200 font-semibold")}>
      <td className="py-2 pr-3 text-slate-700">{label}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{m.orders}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{money(m.sales, cur)}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">−{money(m.fees, cur)}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">−{money(m.shippingLabels, cur)}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">−{money(m.refunds, cur)}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">+{money(m.credits, cur)}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
        −{money(m.costOfGoods, cur)}
        {m.missingCostOrders > 0 && (
          <span className="ml-1" title={`${m.missingCostOrders} orders without a cost - not included`}>
            <Badge color="yellow">{m.missingCostOrders} missing</Badge>
          </span>
        )}
      </td>
      <td className={cx("py-2 text-right tabular-nums", m.net < 0 ? "text-rose-600" : "text-slate-900")}>
        <div className="flex items-center justify-end gap-2">
          {!isTotal && (
            <span className="hidden h-2 w-20 overflow-hidden rounded-full bg-slate-100 md:block" aria-hidden>
              <span
                className={cx("block h-2 rounded-full", m.net < 0 ? "bg-rose-400" : "bg-brand-500")}
                style={{ width: `${(Math.abs(m.net) / maxAbs) * 100}%` }}
              />
            </span>
          )}
          <span className="font-semibold">{money(m.net, cur)}</span>
        </div>
      </td>
    </tr>
  );

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-3">Month</th>
              <th className="py-2 pr-3 text-right">Orders</th>
              <th className="py-2 pr-3 text-right">Sales</th>
              <th className="py-2 pr-3 text-right">eBay fees</th>
              <th className="py-2 pr-3 text-right">Labels</th>
              <th className="py-2 pr-3 text-right">Refunds</th>
              <th className="py-2 pr-3 text-right">Credits</th>
              <th className="py-2 pr-3 text-right">Item costs</th>
              <th className="py-2 text-right">Net profit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.months.map((m) => row(m, monthName(m.month)))}
            {row(total as any, "Last 12 months", true)}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Sales are before eBay fees. Fees include final value, promoted listing and other eBay charges. Transfers between you and eBay aren&apos;t
        income or cost, so they&apos;re left out. Orders with no item cost entered count their cost as zero.
      </p>
    </div>
  );
}
