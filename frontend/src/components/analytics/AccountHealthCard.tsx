"use client";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { Badge, Card, Empty, cx } from "@/components/ui";
import { dateTime } from "@/lib/api";
import { LEVEL_LABEL, type AnalyticsOverview } from "@/lib/analytics";

type Status = "good" | "warning" | "critical";
const STATUS: Record<Status, { label: string; icon: typeof CheckCircle2; text: string; bar: string }> = {
  good: { label: "Top Rated level", icon: CheckCircle2, text: "text-emerald-700", bar: "bg-emerald-500" },
  warning: { label: "Above Standard level", icon: AlertTriangle, text: "text-amber-700", bar: "bg-amber-500" },
  critical: { label: "Below Standard", icon: ShieldAlert, text: "text-rose-700", bar: "bg-rose-500" },
};

const RATING_COLOR: Record<string, "green" | "yellow" | "red" | "gray"> = { LOW: "green", AVERAGE: "gray", HIGH: "yellow", VERY_HIGH: "red" };

/** Seller level + the three rates eBay grades you on, each against eBay's limits. */
export function AccountHealthCard({ data }: { data: AnalyticsOverview }) {
  const h = data.health;
  if (!h) {
    return (
      <Card title="Account health">
        <Empty title="No seller standards yet">They load with the next Analytics refresh.</Empty>
      </Card>
    );
  }
  const current = h.profiles.filter((p) => p.cycle === "CURRENT");
  const profile = current.find((p) => p.defaultProgram) ?? current[0] ?? h.profiles[0];
  const projected = h.profiles.find((p) => p.cycle === "PROJECTED" && p.program === profile?.program);
  const level = h.sellerLevel ?? profile?.level ?? null;

  return (
    <Card
      title="Account health"
      actions={
        level && (
          <Badge color={level === "TOP_RATED" ? "green" : level === "ABOVE_STANDARD" ? "blue" : "red"}>{LEVEL_LABEL[level] ?? level}</Badge>
        )
      }
    >
      <div className="space-y-5">
        <div className="text-sm text-slate-600">
          Seller level <b className="text-slate-900">{level ? LEVEL_LABEL[level] ?? level : "unknown"}</b>
          {profile?.evaluationDate && <> · evaluated {dateTime(profile.evaluationDate)}</>}
          {projected?.level && projected.level !== level && (
            <>
              {" "}
              · projected next: <b className="text-slate-900">{LEVEL_LABEL[projected.level] ?? projected.level}</b>
            </>
          )}
        </div>

        {Object.entries(data.thresholds).map(([key, t]) => {
          const m = profile?.metrics.find((x) => x.key === key);
          const value = m?.value ?? null;
          const topRated = t.topRated;
          const status: Status | null = value === null ? null : value <= topRated ? "good" : value <= t.aboveStandard ? "warning" : "critical";
          const S = status ? STATUS[status] : null;
          const scaleMax = Math.max(t.aboveStandard * 1.5, value ?? 0, 0.5);
          return (
            <div key={key}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-slate-800">{m?.name ?? t.label}</span>
                <span className="text-sm tabular-nums">
                  <b className="text-slate-900">{value === null ? "—" : `${value.toFixed(2)}%`}</b>
                  {m?.numerator !== null && m?.numerator !== undefined && m.denominator ? (
                    <span className="text-xs text-slate-500">
                      {" "}
                      ({m.numerator} of {m.denominator})
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="relative mt-1.5 h-2 rounded-full bg-slate-100">
                {value !== null && S && (
                  <div className={cx("h-2 rounded-full", S.bar)} style={{ width: `${Math.min(100, (value / scaleMax) * 100)}%` }} />
                )}
                {[topRated, t.aboveStandard].map((lim, i) => (
                  <span
                    key={i}
                    className="absolute -top-0.5 h-3 w-0.5 bg-slate-400"
                    style={{ left: `${Math.min(100, (lim / scaleMax) * 100)}%` }}
                    title={i ? `Above Standard limit ${lim}%` : `Top Rated limit ${lim}%`}
                  />
                ))}
              </div>
              <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
                <span>
                  eBay limits: Top Rated ≤ {topRated}% · Above Standard ≤ {t.aboveStandard}%
                </span>
                {S && (
                  <span className={cx("inline-flex items-center gap-1 font-medium", S.text)}>
                    <S.icon className="h-3.5 w-3.5" /> {S.label}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {h.customerService.length > 0 && (
          <div>
            <div className="mb-2 text-sm font-medium text-slate-800">Customer service vs. similar sellers</div>
            <ul className="space-y-1.5 text-sm">
              {h.customerService.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-600">
                    {c.type === "ITEM_NOT_RECEIVED" ? "Item not received" : "Not as described"} · {c.dimension}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-slate-900">{c.rate === null ? "—" : `${c.rate}%`}</span>
                    {c.rating && <Badge color={RATING_COLOR[c.rating] ?? "gray"}>{c.rating.replace("_", " ").toLowerCase()}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
