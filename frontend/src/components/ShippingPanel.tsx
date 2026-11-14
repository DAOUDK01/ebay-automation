"use client";
import { AlertTriangle, CheckCircle2, Package } from "lucide-react";
import { kg } from "@/lib/shipping";
import type { ShippingAnalysis } from "@/lib/types";
import { Badge, cx } from "./ui";

/** Shipping weight breakdown for one listing: actual vs dimensional vs billable, and the right policy. */
export function ShippingPanel({ s, switching }: { s: ShippingAnalysis; switching: boolean }) {
  const p = s.package;
  const tone = s.source === "none" ? "gray" : s.matches ? "ok" : "warn";
  return (
    <div>
      <div className="label flex flex-wrap items-center gap-2">
        <span>Shipping weight</span>
        {s.source === "listing" && <Badge color="blue">from listing</Badge>}
        {s.source === "estimate" && <Badge color="indigo">estimated · {s.confidence ?? "?"} confidence</Badge>}
        {switching && <Badge color="green">policy will be changed</Badge>}
      </div>

      {s.source === "none" ? (
        <p className="text-sm text-slate-500">{s.note}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Actual" value={kg(s.actualKg)} />
            <Metric label={`Dimensional (÷${s.divisor})`} value={kg(s.dimensionalKg)} hint={p ? `${p.lengthCm}×${p.widthCm}×${p.heightCm} cm` : undefined} />
            <Metric label="Billable" value={kg(s.billableKg)} strong={s.dimensionalKg > s.actualKg ? "dimensional" : "actual"} />
            <Metric label="Weight bracket" value={`${s.categoryKg} kg`} highlight />
          </div>

          <div
            className={cx(
              "mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm",
              tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900",
            )}
          >
            {tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <div className="min-w-0">
              <div>{s.note}</div>
              <div className="mt-0.5 text-xs opacity-80">
                Current: <b>{s.current?.name || "none"}</b>
                {s.suggested && !s.matches && (
                  <>
                    {" "}
                    → Suggested: <b>{s.suggested.name}</b>
                  </>
                )}
              </div>
            </div>
          </div>
          {s.basis && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
              <Package className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Estimate basis: {s.basis}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, hint, highlight, strong }: { label: string; value: string; hint?: string; highlight?: boolean; strong?: string }) {
  return (
    <div className={cx("rounded-md border px-3 py-2", highlight ? "border-brand-200 bg-brand-50" : "border-slate-200 bg-white")}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx("text-base font-semibold tabular-nums", highlight ? "text-brand-700" : "text-slate-900")}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
      {strong && <div className="text-[11px] text-slate-500">uses {strong} weight</div>}
    </div>
  );
}
