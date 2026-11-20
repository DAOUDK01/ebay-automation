"use client";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "@/components/toast";
import { Badge, Button, Card, Empty, Spinner } from "@/components/ui";
import { api, fetcher, timeAgo } from "@/lib/api";
import { DEFAULT_LEAVE_TEXT, FEEDBACK_MAX, type AwaitingFeedback as Row, type LeaveResult } from "@/lib/feedback";
import { LimitedText, Modal } from "./Modal";

/** Sales waiting for us to rate the buyer: leave positive one at a time or in bulk (always confirmed). */
export function AwaitingFeedback({ storeId, defaultText, onChanged }: { storeId: string; defaultText: string; onChanged: () => void }) {
  const { data, mutate } = useSWR<{ items: Row[]; total: number }>(`/stores/${storeId}/feedback/awaiting`, fetcher);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Row[] | null>(null);
  const [text, setText] = useState(defaultText || DEFAULT_LEAVE_TEXT);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<LeaveResult[] | null>(null);
  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((r) => selected.has(r._id));

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function leave() {
    if (!leaving) return;
    const who = leaving.length === 1 ? leaving[0].buyer : `${leaving.length} buyers`;
    if (!confirm(`Leave positive feedback for ${who} on eBay?\n\n"${text.trim()}"\n\nFeedback can't be changed once it's left.`)) return;
    setBusy(true);
    try {
      const r = await api<{ results: LeaveResult[]; ok: number; failed: number }>(`/stores/${storeId}/feedback/leave`, {
        body: { ids: leaving.map((x) => x._id), text: text.trim() },
      });
      if (r.failed) {
        toast.error(`${r.ok} left, ${r.failed} failed`);
        setResults(r.results);
      } else toast.success(`Positive feedback left for ${r.ok === 1 ? leaving[0].buyer : `${r.ok} buyers`}`);
      setLeaving(null);
      setSelected(new Set());
      mutate();
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const selectedRows = items.filter((r) => selected.has(r._id));
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Awaiting your feedback {data && <Badge color={data.total ? "yellow" : "gray"}>{data.total}</Badge>}
        </span>
      }
      actions={
        <Button size="sm" variant="success" disabled={!selectedRows.length} onClick={() => (setResults(null), setLeaving(selectedRows))}>
          Leave positive{selectedRows.length ? ` (${selectedRows.length})` : ""}
        </Button>
      }
    >
      {results && (
        <ul className="mb-3 space-y-1 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          {results.filter((r) => !r.ok).map((r) => (
            <li key={r.id}>
              {r.buyer || r.id}: {r.error}
            </li>
          ))}
        </ul>
      )}
      {!data ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : !items.length ? (
        <Empty title="All caught up">Every buyer has feedback from you.</Empty>
      ) : (
        <div>
          <label className="flex items-center gap-2 border-b border-slate-200 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((r) => r._id)))} />
            Select all
          </label>
          <ul className="divide-y divide-slate-100">
            {items.map((r) => (
              <li key={r._id} className="flex items-center gap-3 py-2.5">
                <input type="checkbox" aria-label={`Select ${r.buyer}`} checked={selected.has(r._id)} onChange={() => toggle(r._id)} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-700">{r.buyer}</div>
                  <div className="truncate text-xs text-slate-500" title={r.title}>
                    {r.title || r.itemId} · sold {timeAgo(r.endTime)}
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => (setResults(null), setLeaving([r]))}>
                  Leave
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {leaving && (
        <Modal
          title={leaving.length === 1 ? `Leave feedback for ${leaving[0].buyer}` : `Leave feedback for ${leaving.length} buyers`}
          onClose={() => setLeaving(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setLeaving(null)}>
                Cancel
              </Button>
              <Button variant="success" onClick={leave} loading={busy} disabled={!text.trim()}>
                Leave positive feedback
              </Button>
            </>
          }
        >
          <p className="text-slate-600">
            Sellers can only leave <b>positive</b> feedback for buyers. The same comment is used for every buyer selected.
          </p>
          <LimitedText value={text} onChange={setText} max={FEEDBACK_MAX} />
        </Modal>
      )}
    </Card>
  );
}
