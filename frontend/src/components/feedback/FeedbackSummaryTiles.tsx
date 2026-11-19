"use client";
import { Stat } from "@/components/ui";
import { timeAgo } from "@/lib/api";
import type { FeedbackSummary } from "@/lib/feedback";

const PERIOD_LABEL = { "30": "Last 30 days", "90": "Last 90 days", "365": "Last 12 months" } as const;

export function FeedbackSummaryTiles({ s }: { s: FeedbackSummary }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Stat
        label="Feedback score"
        value={s.score ?? "—"}
        hint={s.positivePercent !== null ? `${s.positivePercent}% positive${s.star ? ` · ${s.star} star` : ""}` : `Updated ${timeAgo(s.profileUpdatedAt)}`}
      />
      {(["30", "90", "365"] as const).map((p) => {
        const c = s.periods[p];
        return (
          <Stat
            key={p}
            label={PERIOD_LABEL[p]}
            value={
              <span className="flex items-baseline gap-3 text-xl">
                <span className="text-emerald-600" title="Positive">+{c.positive}</span>
                <span className="text-amber-600" title="Neutral">○{c.neutral}</span>
                <span className="text-rose-600" title="Negative">−{c.negative}</span>
              </span>
            }
            hint={c.source === "ebay" ? "From eBay" : "From synced feedback"}
          />
        );
      })}
      <Stat
        label="Needs a reply"
        value={<span className={s.needsReply ? "text-rose-600" : undefined}>{s.needsReply}</span>}
        hint="Neutral/negative, last 30 days"
      />
    </div>
  );
}
