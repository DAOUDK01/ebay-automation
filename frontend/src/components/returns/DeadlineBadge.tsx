"use client";
import { AlarmClock } from "lucide-react";
import { cx } from "@/components/ui";
import { dateTime } from "@/lib/api";
import { timeLeft, urgency } from "@/lib/returns";

const STYLE = {
  overdue: "bg-rose-600 text-white ring-rose-700",
  today: "bg-rose-50 text-rose-700 ring-rose-600/30",
  soon: "bg-amber-50 text-amber-800 ring-amber-600/30",
  later: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

/** eBay "respond by" deadline: red when overdue / under 24h, amber under 48h. */
export function DeadlineBadge({ respondBy, large }: { respondBy: string | null; large?: boolean }) {
  const u = urgency(respondBy);
  if (u === "none" || !respondBy) return null;
  return (
    <span
      title={`eBay deadline: ${dateTime(respondBy)}`}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold ring-1 ring-inset",
        large ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs",
        STYLE[u],
      )}
    >
      <AlarmClock className={large ? "h-4 w-4" : "h-3 w-3"} />
      {timeLeft(respondBy)}
    </span>
  );
}
