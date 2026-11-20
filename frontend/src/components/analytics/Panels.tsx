"use client";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { money } from "@/lib/api";
import type { RangeDays, SalesReport, TrafficTotals } from "@/lib/analytics";
import { cx } from "../ui";

/** +12.5% / -4% vs the previous period (green up, red down; `invert` for things where down is good). */
export function Delta({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  if (value === undefined) return null;
  if (value === null) return <span className="text-xs text-slate-400">new</span>;
  const up = value > 0;
  const good = invert ? !up : up;
  const Icon = value === 0 ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cx("inline-flex items-center gap-0.5 text-xs font-semibold", value === 0 ? "text-slate-400" : good ? "text-emerald-600" : "text-rose-600")}>
      <Icon className="h-3.5 w-3.5" />
      {Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}%
    </span>
  );
}

export function Kpi({ label, value, delta, hint, invert }: { label: string; value: ReactNode; delta?: number | null; hint?: ReactNode; invert?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-2xl font-semibold text-slate-900">{value}</div>
        <Delta value={delta} invert={invert} />
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function RangeToggle({ value, onChange }: { value: RangeDays; onChange: (v: RangeDays) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
      {([7, 30, 90] as const).map((d) => (
        <button
          key={d}
          onClick={() => onChange(d)}
          className={cx("px-3 py-1.5 font-medium", value === d ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50")}
        >
          {d} days
        </button>
      ))}
    </div>
  );
}

/** Impressions -> views -> sales, with the step rates. */
export function Funnel({ t }: { t: TrafficTotals }) {
  const steps = [
    { label: "Impressions", value: t.impressions, rate: null as string | null },
    { label: "Views", value: t.views, rate: t.ctr === null ? null : `${t.ctr.toFixed(2)}% click-through` },
    { label: "Sales", value: t.transactions, rate: t.conversion === null ? null : `${t.conversion.toFixed(2)}% conversion` },
  ];
  const max = Math.max(1, t.impressions);
  return (
    <div className="space-y-3">
      {steps.map((s) => (
        <div key={s.label}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium text-slate-700">{s.label}</span>
            <span className="tabular-nums text-slate-900">
              {s.value.toLocaleString()} {s.rate && <span className="ml-1 text-xs text-slate-500">· {s.rate}</span>}
            </span>
          </div>
          <div className="mt-1 h-2.5 rounded-full bg-slate-100">
            <div className="h-2.5 rounded-full bg-brand-500" style={{ width: `${Math.max(1.5, (s.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Orders by weekday as horizontal bars. */
export function WeekdayBars({ rows, currency }: { rows: SalesReport["weekday"]; currency: string }) {
  const max = Math.max(1, ...rows.map((r) => r.orders));
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  return (
    <div className="space-y-1.5">
      {order.map((i) => {
        const r = rows[i];
        return (
          <div key={r.day} className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-2 text-sm">
            <span className="text-slate-500">{r.day}</span>
            <div className="h-2.5 rounded-full bg-slate-100">
              <div className="h-2.5 rounded-full bg-emerald-500" style={{ width: `${(r.orders / max) * 100}%` }} />
            </div>
            <span className="w-28 text-right tabular-nums text-slate-700">
              {r.orders} · {money(r.revenue, currency)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TopSellers({ storeId, rows, currency }: { storeId: string; rows: SalesReport["topItems"]; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 pr-3">Item</th>
            <th className="py-2 pr-3 text-right">Units</th>
            <th className="py-2 pr-3 text-right">Orders</th>
            <th className="py-2 text-right">Revenue</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.itemId || r.title}>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  {r.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.image} alt="" className="h-8 w-8 shrink-0 rounded border border-slate-200 object-cover" />
                  ) : (
                    <div className="h-8 w-8 shrink-0 rounded bg-slate-100" />
                  )}
                  {r.itemId ? (
                    <Link href={`/stores/${storeId}/listings/${r.itemId}`} className="line-clamp-2 text-slate-800 hover:underline">
                      {r.title || r.itemId}
                    </Link>
                  ) : (
                    <span className="line-clamp-2">{r.title}</span>
                  )}
                </div>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.units}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.orders}</td>
              <td className="py-2 text-right font-medium tabular-nums">{money(r.revenue, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
