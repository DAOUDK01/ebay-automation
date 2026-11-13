"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useStore } from "@/components/StoreContext";
import { toast } from "@/components/toast";
import { Alert, Button, Card, Stat, StatusBadge, Toggle } from "@/components/ui";
import { api, dateTime, money, timeAgo } from "@/lib/api";

function Overview() {
  const { data, mutate } = useStore();
  const params = useSearchParams();
  const { store, jobs, batches, usage } = data;
  const st = store.stats!;
  const s = store.settings;
  const [busy, setBusy] = useState("");
  const [limit, setLimit] = useState(5);
  const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued");
  const budgetPct = s.claude.monthlyBudgetUsd ? Math.min(100, (st.monthSpendUsd / s.claude.monthlyBudgetUsd) * 100) : 0;

  async function act(key: string, fn: () => Promise<any>, ok: string) {
    setBusy(key);
    try {
      const r = await fn();
      toast[r?.duplicate ? "info" : "success"](r?.duplicate ? "Already queued" : ok);
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-6">
      {params.get("connected") && (
        <Alert kind="success">
          eBay account connected. Next: click <b>Sync listings</b>, then run a small test batch. Review the result before switching
          on the automatic runner.
        </Alert>
      )}
      {store.runner.lastError && <Alert kind="warning">Last runner error: {store.runner.lastError}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active listings" value={st.activeListings} hint={`last sync ${timeAgo(store.lastSyncAt)}`} />
        <Stat
          label="Optimized"
          value={st.processedListings}
          hint={st.activeListings ? `${Math.round((st.processedListings / st.activeListings) * 100)}% of store · ${st.neverProcessed} never touched` : ""}
        />
        <Stat label="Waiting for review" value={st.pendingReview} hint={`${st.pushedTotal} changes pushed in total`} />
        <Stat
          label="Claude spend this month"
          value={money(st.monthSpendUsd)}
          hint={
            <div>
              <div className="mt-1 h-1.5 w-full rounded bg-slate-100">
                <div className={`h-1.5 rounded ${budgetPct > 90 ? "bg-rose-500" : "bg-brand-500"}`} style={{ width: `${budgetPct}%` }} />
              </div>
              <div className="mt-1">
                of {money(s.claude.monthlyBudgetUsd)} budget · {st.monthCalls} listings analysed
              </div>
            </div>
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Automatic runner" className="lg:col-span-1">
          <div className="space-y-4">
            <Toggle
              checked={store.runner.enabled}
              disabled={busy === "runner"}
              onChange={(v) =>
                act("runner", () => api(`/stores/${store.id}/runner`, { body: { enabled: v } }), v ? "Runner started" : "Runner paused")
              }
              label={<span className="font-medium">{store.runner.enabled ? "Running" : "Paused"}</span>}
            />
            <dl className="space-y-1 text-sm text-slate-600">
              <div className="flex justify-between">
                <dt>Next batch</dt>
                <dd>{store.runner.enabled ? timeAgo(store.runner.nextRunAt) : "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Last batch</dt>
                <dd>{timeAgo(store.runner.lastBatchAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Batch size / gap</dt>
                <dd>
                  {s.batchSize} listings / {s.gapBetweenBatchesMin} min
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Active hours</dt>
                <dd>{s.activeHours.enabled ? `${s.activeHours.start}–${s.activeHours.end}` : "24/7"}</dd>
              </div>
            </dl>
            {s.mode === "auto" ? (
              <p className="text-xs text-slate-500">Auto mode: changes are pushed to eBay at the end of each batch.</p>
            ) : (
              <p className="text-xs text-slate-500">Review mode: each batch waits for your approval before anything is pushed.</p>
            )}
          </div>
        </Card>

        <Card title="Manual actions" className="lg:col-span-2">
          <div className="flex flex-wrap items-end gap-3">
            <Button
              variant="secondary"
              loading={busy === "sync"}
              onClick={() => act("sync", () => api(`/stores/${store.id}/sync`, { method: "POST" }), "Sync queued")}
            >
              Sync listings from eBay
            </Button>
            <div className="flex items-end gap-2">
              <div>
                <label className="label">Listings</label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  className="input w-24"
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </div>
              <Button
                loading={busy === "run"}
                onClick={() => act("run", () => api(`/stores/${store.id}/run`, { body: { limit } }), "Batch queued")}
              >
                Run a batch now
              </Button>
            </div>
          </div>
          {activeJob && (
            <div className="mt-4 flex items-center justify-between rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">
              <span>
                <StatusBadge status={activeJob.status} /> {activeJob.type} job {activeJob.status === "running" ? `started ${timeAgo(activeJob.startedAt)}` : "waiting for the worker"}
              </span>
              <button
                className="text-xs underline"
                onClick={() => act("cancel", () => api(`/stores/${store.id}/jobs/${activeJob._id}/cancel`, { method: "POST" }), "Cancelled")}
              >
                cancel
              </button>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Jobs are executed by the background worker (<code>npm run dev:worker</code>). If jobs stay “queued”, the worker isn&apos;t running.
          </p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent batches" actions={<Link className="text-xs text-brand-600" href={`/stores/${store.id}/batches`}>View all</Link>}>
          {!batches.length ? (
            <p className="text-sm text-slate-500">No batches yet.</p>
          ) : (
            <table className="w-full">
              <tbody className="divide-y divide-slate-100">
                {batches.map((b) => (
                  <tr key={b._id}>
                    <td className="table-td">
                      <Link className="font-medium text-brand-700" href={`/stores/${store.id}/batches/${b._id}`}>
                        #{b.number}
                      </Link>
                    </td>
                    <td className="table-td">
                      <StatusBadge status={b.status} />
                    </td>
                    <td className="table-td text-slate-600">
                      {b.counts.processed}/{b.counts.total} done · {b.counts.proposed} to review · {b.counts.pushed} pushed
                    </td>
                    <td className="table-td text-right text-slate-500">{timeAgo(b.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Worker jobs">
          {!jobs.length ? (
            <p className="text-sm text-slate-500">No jobs yet.</p>
          ) : (
            <table className="w-full">
              <tbody className="divide-y divide-slate-100">
                {jobs.map((j) => (
                  <tr key={j._id}>
                    <td className="table-td font-medium">{j.type}</td>
                    <td className="table-td">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="table-td max-w-xs truncate text-xs text-rose-600" title={j.error}>
                      {j.error}
                    </td>
                    <td className="table-td text-right text-slate-500">{dateTime(j.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!usage.length && (
            <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
              Monthly spend:{" "}
              {usage.map((u) => (
                <span key={u.month} className="mr-3">
                  {u.month}: {money(u.usd)}
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function StoreOverviewPage() {
  return (
    <Suspense>
      <Overview />
    </Suspense>
  );
}
