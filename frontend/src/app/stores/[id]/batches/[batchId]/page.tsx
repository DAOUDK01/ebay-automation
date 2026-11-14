"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { ProposalCard } from "@/components/ProposalCard";
import { toast } from "@/components/toast";
import { Alert, Button, Card, Spinner, StatusBadge, cx } from "@/components/ui";
import { api, dateTime, fetcher, money } from "@/lib/api";
import type { Batch, Proposal } from "@/lib/types";

const FILTERS = [
  { key: "review", label: "To review", match: (p: Proposal) => ["proposed", "approved"].includes(p.status) },
  { key: "pushed", label: "Pushed", match: (p: Proposal) => ["pushed", "reverted"].includes(p.status) },
  { key: "problems", label: "Errors", match: (p: Proposal) => ["error", "failed"].includes(p.status) },
  { key: "other", label: "No change / rejected", match: (p: Proposal) => ["no_change", "skipped", "rejected"].includes(p.status) },
  { key: "all", label: "All", match: () => true },
];

export default function BatchReviewPage() {
  const { id, batchId } = useParams<{ id: string; batchId: string }>();
  const { data, mutate } = useSWR<{ batch: Batch; proposals: Proposal[] }>(`/stores/${id}/batches/${batchId}`, fetcher, {
    refreshInterval: (d) => (d && ["running", "pushing"].includes(d.batch.status) ? 4000 : 0),
  });
  const [filter, setFilter] = useState("review");
  const [busy, setBusy] = useState("");

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, data?.proposals.filter(f.match).length ?? 0])),
    [data],
  );

  if (!data)
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Spinner />
      </div>
    );
  const { batch, proposals } = data;
  const approved = proposals.filter((p) => p.status === "approved").length;
  const proposed = proposals.filter((p) => p.status === "proposed").length;
  const shown = proposals.filter(FILTERS.find((f) => f.key === filter)!.match);

  async function approveAll() {
    setBusy("approve");
    try {
      const r = await api<{ approved: number }>(`/stores/${id}/batches/${batchId}/approve-all`, { method: "POST" });
      toast.success(`${r.approved} changes approved`);
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  }

  const failed = proposals.filter((p) => p.status === "error").length;

  async function retryFailed() {
    setBusy("retry");
    try {
      const r = await api<{ count: number }>(`/stores/${id}/batches/${batchId}/retry-errors`, { method: "POST" });
      toast.success(`Retrying ${r.count} listing(s) in a new batch - see Review & batches`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  }

  async function push() {
    if (!confirm(`Push ${approved} approved change(s) to eBay now?`)) return;
    setBusy("push");
    try {
      await api(`/stores/${id}/batches/${batchId}/push`, { method: "POST" });
      toast.success("Push queued - the worker is updating eBay");
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      <Link href={`/stores/${id}/batches`} className="text-xs text-slate-500 hover:text-slate-700">
        ← All batches
      </Link>
      <Card
        title={
          <span className="flex items-center gap-2">
            Batch #{batch.number} <StatusBadge status={batch.status} />
          </span>
        }
        actions={
          <>
            {failed > 0 && (
              <Button variant="secondary" size="sm" loading={busy === "retry"} onClick={retryFailed}>
                Retry {failed} failed
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={!proposed} loading={busy === "approve"} onClick={approveAll}>
              Approve all ({proposed})
            </Button>
            <Button size="sm" disabled={!approved || batch.status === "pushing"} loading={busy === "push"} onClick={push}>
              Push {approved} approved to eBay
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
          <span>
            Processed {batch.counts.processed}/{batch.counts.total}
          </span>
          <span>Pushed {batch.counts.pushed}</span>
          <span>No change {batch.counts.noChange}</span>
          <span>Errors {batch.counts.errors + batch.counts.failed}</span>
          <span>Claude cost {money(batch.costUsd)}</span>
          <span>
            {batch.mode} mode · started {dateTime(batch.startedAt)}
          </span>
        </div>
        {batch.status === "running" && (
          <div className="mt-3">
            <Alert kind="info">This batch is still being processed - results appear as each listing finishes.</Alert>
          </div>
        )}
        {batch.status === "pushing" && (
          <div className="mt-3">
            <Alert kind="info">Pushing approved changes to eBay…</Alert>
          </div>
        )}
        {batch.error && (
          <div className="mt-3">
            <Alert kind="warning">{batch.error}</Alert>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cx(
              "rounded-full px-3 py-1 text-sm",
              filter === f.key ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
            )}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      {!shown.length ? (
        <p className="py-10 text-center text-sm text-slate-500">Nothing here.</p>
      ) : (
        <div className="space-y-4">
          {shown.map((p) => (
            <ProposalCard key={p._id} storeId={id} p={p} onChange={() => mutate()} />
          ))}
        </div>
      )}
    </div>
  );
}
