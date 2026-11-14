"use client";
import { CheckCircle2, Loader2, UploadCloud, WandSparkles, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { money } from "@/lib/api";
import type { Batch } from "@/lib/types";
import { cx } from "./ui";

/** re-render every second so elapsed time / ETA tick between data refreshes */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const fmtSecs = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

function eta(startedAt: string | null | undefined, done: number, total: number, now: number) {
  if (!startedAt || done <= 0 || done >= total) return "";
  const elapsed = (now - new Date(startedAt).getTime()) / 1000;
  return `about ${fmtSecs((elapsed / done) * (total - done))} left`;
}

function Bar({ value, total, tone = "brand", indeterminate }: { value: number; total: number; tone?: "brand" | "emerald"; indeterminate?: boolean }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div
      className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-200/70"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={indeterminate ? undefined : value}
    >
      {indeterminate ? (
        <div className="absolute inset-y-0 w-1/3 animate-progress-slide rounded-full bg-brand-500/70" />
      ) : (
        <div
          className={cx(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            tone === "emerald" ? "bg-emerald-500" : "bg-gradient-to-r from-brand-500 to-brand-600",
          )}
          style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }}
        />
      )}
    </div>
  );
}

function Panel({ icon, title, right, children, tone = "brand" }: { icon: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode; tone?: "brand" | "emerald" | "rose" }) {
  return (
    <div
      className={cx(
        "rounded-lg border px-4 py-3",
        tone === "emerald" ? "border-emerald-200 bg-emerald-50/60" : tone === "rose" ? "border-rose-200 bg-rose-50/60" : "border-brand-100 bg-brand-50/50",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
          {icon}
          {title}
        </div>
        {right && <div className="text-sm font-semibold tabular-nums text-slate-700">{right}</div>}
      </div>
      {children}
    </div>
  );
}

/** Live progress for a batch: optimizing listings, pushing to eBay, and a short summary after a push finishes. */
export function BatchProgress({ batch }: { batch: Batch }) {
  const active = batch.status === "running" || batch.status === "pushing";
  const now = useNow(active);

  if (batch.status === "running") {
    const { processed, total } = batch.counts;
    const pct = total ? Math.round((processed / total) * 100) : 0;
    return (
      <Panel icon={<WandSparkles className="h-4 w-4 animate-pulse text-brand-600" />} title="Optimizing listings with Claude…" right={`${pct}%`}>
        <Bar value={processed} total={total} />
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
          <span>
            {processed} of {total} listings analysed · {batch.counts.proposed} with suggestions
            {batch.counts.errors ? ` · ${batch.counts.errors} failed` : ""}
          </span>
          <span>
            {money(batch.costUsd)} so far{eta(batch.startedAt, processed, total, now) && ` · ${eta(batch.startedAt, processed, total, now)}`}
          </span>
        </div>
      </Panel>
    );
  }

  const push = batch.push;
  if (batch.status === "pushing") {
    if (!push?.startedAt) {
      return (
        <Panel icon={<Loader2 className="h-4 w-4 animate-spin text-brand-600" />} title="Waiting for the worker to start the push…">
          <Bar value={0} total={1} indeterminate />
          <p className="mt-2 text-xs text-slate-500">
            {push?.total ? `${push.total} approved change(s) queued.` : "Queued."} This usually starts within ~20 seconds.
          </p>
        </Panel>
      );
    }
    const pct = push.total ? Math.round((push.done / push.total) * 100) : 0;
    const left = eta(push.startedAt, push.done, push.total, now);
    return (
      <Panel icon={<UploadCloud className="h-4 w-4 animate-pulse text-brand-600" />} title="Pushing approved changes to eBay…" right={`${pct}%`}>
        <Bar value={push.done} total={push.total} />
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
          <span>
            {push.done} of {push.total} updated
            {push.failed ? <span className="text-rose-600"> · {push.failed} failed</span> : null}
            {push.currentItemId ? ` · now updating item ${push.currentItemId}` : ""}
          </span>
          {left && <span>{left}</span>}
        </div>
      </Panel>
    );
  }

  // finished recently -> show a summary for a few minutes
  if (push?.finishedAt && push.total && now - new Date(push.finishedAt).getTime() < 5 * 60_000) {
    const ok = push.done - push.failed;
    return (
      <Panel
        tone={push.failed ? "rose" : "emerald"}
        icon={push.failed ? <XCircle className="h-4 w-4 text-rose-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
        title={push.failed ? `Push finished with ${push.failed} failure(s)` : "Push finished"}
        right="100%"
      >
        <Bar value={push.total} total={push.total} tone="emerald" />
        <p className="mt-2 text-xs text-slate-500">
          {ok} of {push.total} listing(s) updated on eBay{push.failed ? " - open the Errors tab to see why the rest failed" : ""}.
        </p>
      </Panel>
    );
  }
  return null;
}
