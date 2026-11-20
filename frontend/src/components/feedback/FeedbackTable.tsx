"use client";
import { useState } from "react";
import useSWR from "swr";
import { Badge, Button, Card, cx, Empty, Pagination, Spinner } from "@/components/ui";
import { fetcher, money, timeAgo } from "@/lib/api";
import { FEEDBACK_FILTERS, ratingColor, type FeedbackEntry } from "@/lib/feedback";
import type { Paged } from "@/lib/types";
import { ReplyDialog } from "./ReplyDialog";

const pill = (active: boolean) =>
  cx("rounded-full px-3 py-1 text-xs font-medium transition", active ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200");

/** Feedback received / left with rating filters, search and the public reply action. */
export function FeedbackTable({ storeId, onChanged }: { storeId: string; onChanged: () => void }) {
  const [direction, setDirection] = useState<"received" | "left">("received");
  const [rating, setRating] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [replying, setReplying] = useState<FeedbackEntry | null>(null);
  const key = `/stores/${storeId}/feedback?direction=${direction}&rating=${rating}&q=${encodeURIComponent(search)}&page=${page}`;
  const { data, mutate } = useSWR<Paged<FeedbackEntry>>(key, fetcher);
  const set = (fn: () => void) => (fn(), setPage(1));

  return (
    <Card
      title={
        <span className="flex gap-1">
          {(["received", "left"] as const).map((d) => (
            <button key={d} type="button" className={pill(direction === d)} onClick={() => {
                setDirection(d);
                if (d === "left" && rating === "needs_reply") setRating("");
                setPage(1);
              }}
            >
              {d === "received" ? "Received" : "Left for buyers"}
            </button>
          ))}
        </span>
      }
      actions={
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            set(() => setSearch(q));
          }}
        >
          <input className="input w-56 py-1.5" placeholder="Search buyer, comment, item" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" size="sm" variant="secondary">
            Search
          </Button>
        </form>
      }
    >
      <div className="mb-4 flex flex-wrap gap-2 border-b border-slate-100 pb-3">
        {FEEDBACK_FILTERS.map((f) => (
          <button key={f.key} type="button" className={pill(rating === f.key)} onClick={() => set(() => setRating(f.key))}>
            {f.label}
          </button>
        ))}
        {direction === "received" && (
          <button type="button" className={pill(rating === "needs_reply")} onClick={() => set(() => setRating("needs_reply"))}>
            Needs a reply
          </button>
        )}
      </div>

      {!data ? (
        <div className="flex justify-center py-12 text-slate-400">
          <Spinner />
        </div>
      ) : !data.total ? (
        <Empty title="No feedback here">{rating === "needs_reply" ? "Nothing waiting for a reply." : "Feedback appears after the next account sync."}</Empty>
      ) : (
        <>
          <ul className="divide-y divide-slate-100">
            {data.items.map((f) => (
              <li key={f._id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
                <div className="w-24 shrink-0">
                  <Badge color={ratingColor(f.rating)}>{f.rating}</Badge>
                  <div className="mt-1 text-xs text-slate-400">{timeAgo(f.date)}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-800">{f.comment || <span className="italic text-slate-400">No comment</span>}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {f.user ? (
                      <>
                        <span className="font-medium text-slate-600">{f.user}</span>
                        {f.userScore !== null && ` (${f.userScore})`} ·{" "}
                      </>
                    ) : null}
                    {f.itemTitle || f.itemId} {f.itemPrice !== null && `· ${money(f.itemPrice, f.currency)}`}
                  </p>
                  {f.response && (
                    <p className="mt-2 rounded-md border-l-2 border-brand-300 bg-brand-50/40 px-3 py-1.5 text-xs text-slate-700">
                      <span className="font-semibold">Your reply:</span> {f.response}
                    </p>
                  )}
                  {f.followUp && <p className="mt-1 text-xs text-slate-500">Buyer follow-up: {f.followUp}</p>}
                </div>
                {f.direction === "received" && !f.response && f.rating !== "Withdrawn" && (
                  <Button size="sm" variant={f.rating === "Positive" ? "ghost" : "secondary"} onClick={() => setReplying(f)}>
                    Reply
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
      {replying && (
        <ReplyDialog
          storeId={storeId}
          fb={replying}
          onClose={() => setReplying(null)}
          onDone={() => {
            setReplying(null);
            mutate();
            onChanged();
          }}
        />
      )}
    </Card>
  );
}
