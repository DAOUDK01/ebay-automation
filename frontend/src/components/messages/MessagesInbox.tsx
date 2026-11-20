"use client";
import { CornerUpLeft } from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { Empty, Pagination, Spinner, cx } from "@/components/ui";
import { fetcher, timeAgo } from "@/lib/api";
import type { MessageThread, ThreadsResponse } from "@/lib/messages";
import { ThreadView } from "./ThreadView";

export function MessagesInbox({ storeId }: { storeId: string }) {
  const [unread, setUnread] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => setPage(1), [unread, search]);
  const key = `/stores/${storeId}/messages/threads?unread=${unread ? 1 : ""}&q=${encodeURIComponent(search)}&page=${page}`;
  const { data, error, mutate } = useSWR<ThreadsResponse>(key, fetcher, { refreshInterval: 60_000 });

  useEffect(() => {
    if (!selected && data?.items[0] && typeof window !== "undefined" && window.innerWidth >= 1024) setSelected(data.items[0].id);
  }, [data, selected]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {[
            { v: false, label: "All" },
            { v: true, label: `Unread${data?.unreadThreads ? ` (${data.unreadThreads})` : ""}` },
          ].map((o) => (
            <button
              key={String(o.v)}
              type="button"
              onClick={() => setUnread(o.v)}
              className={cx("rounded-md px-3 py-1.5 text-sm font-medium", unread === o.v ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100")}
            >
              {o.label}
            </button>
          ))}
        </div>
        <form
          className="ml-auto w-full sm:w-72"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
          }}
        >
          <input className="input py-1.5" placeholder="Search buyer, item or text…" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setSearch(q.trim())} />
        </form>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className={cx("lg:col-span-2", selected && "hidden lg:block")}>
          {error ? (
            <Empty title="Couldn't load messages">{error.message}</Empty>
          ) : !data ? (
            <div className="flex justify-center py-16 text-slate-400">
              <Spinner />
            </div>
          ) : !data.items.length ? (
            <Empty title={unread ? "All caught up" : "No messages yet"}>
              {unread ? "No unread buyer messages." : "Buyer messages appear here after the next account sync."}
            </Empty>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                {data.items.map((t) => (
                  <ThreadRow key={t.id} t={t} active={selected === t.id} onClick={() => setSelected(t.id)} />
                ))}
              </ul>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </>
          )}
        </div>
        <div className={cx("lg:col-span-3", !selected && "hidden lg:block")}>
          {selected ? (
            <>
              <button type="button" className="mb-3 text-sm font-medium text-brand-700 lg:hidden" onClick={() => setSelected(null)}>
                ← Back to conversations
              </button>
              <ThreadView key={selected} storeId={storeId} threadId={selected} onChanged={() => mutate()} />
            </>
          ) : (
            <Empty title="Pick a conversation" />
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadRow({ t, active, onClick }: { t: MessageThread; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className={cx("block w-full px-4 py-3 text-left transition", active ? "bg-brand-50" : "hover:bg-slate-50")}>
        <div className="flex items-center justify-between gap-2">
          <span className={cx("truncate text-sm", t.unread ? "font-semibold text-slate-900" : "font-medium text-slate-700")}>
            {t.unread > 0 && <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-brand-600 align-middle" />}
            {t.buyer}
          </span>
          <span className="shrink-0 text-xs text-slate-400">{timeAgo(t.lastAt)}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-slate-500">{t.itemTitle || t.subject}</div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
          {t.lastDirection === "out" && <CornerUpLeft className="h-3 w-3 shrink-0" />}
          <span className="truncate">{t.preview || t.subject}</span>
          {t.needsReply && <span className="ml-auto shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">Needs reply</span>}
        </div>
      </button>
    </li>
  );
}
