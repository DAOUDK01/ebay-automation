"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { Empty, Pagination, Spinner, Stat, cx } from "@/components/ui";
import { fetcher, money, timeAgo } from "@/lib/api";
import { humanize, KIND_LABEL, type PostOrderCase, type ReturnsInboxResponse } from "@/lib/returns";
import { DeadlineBadge } from "./DeadlineBadge";
import { ReturnDetail } from "./ReturnDetail";

const KINDS = [
  { key: "", label: "All" },
  { key: "return", label: "Returns" },
  { key: "cancellation", label: "Cancellations" },
  { key: "case", label: "Cases" },
] as const;

const KIND_COLOR: Record<string, string> = {
  return: "bg-sky-50 text-sky-700",
  cancellation: "bg-violet-50 text-violet-700",
  case: "bg-rose-50 text-rose-700",
};

export function ReturnsInbox({ storeId }: { storeId: string }) {
  const [kind, setKind] = useState("");
  const [state, setState] = useState("open");
  const [due, setDue] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ kind: string; ebayId: string } | null>(null);

  useEffect(() => setPage(1), [kind, state, due, search]);
  const key = `/stores/${storeId}/returns?kind=${kind}&state=${state}&due=${due}&q=${encodeURIComponent(search)}&page=${page}`;
  const { data, mutate, error } = useSWR<ReturnsInboxResponse>(key, fetcher, { refreshInterval: 60_000 });

  // open the most urgent one on desktop
  useEffect(() => {
    if (!selected && data?.items[0] && typeof window !== "undefined" && window.innerWidth >= 1024) {
      setSelected({ kind: data.items[0].kind, ebayId: data.items[0].ebayId });
    }
  }, [data, selected]);

  const s = data?.summary;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open returns" value={s?.open.return ?? "—"} />
        <Stat label="Cancellation requests" value={s?.open.cancellation ?? "—"} />
        <Stat label="Open cases" value={s?.open.case ?? "—"} />
        <button type="button" className="text-left" onClick={() => setDue(due === "soon" ? "" : "soon")}>
          <Stat
            label="Due within 48h"
            value={<span className={s?.dueSoon ? "text-rose-600" : ""}>{s?.dueSoon ?? "—"}</span>}
            hint={s?.overdue ? <span className="font-semibold text-rose-600">{s.overdue} overdue</span> : "eBay deadlines"}
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKind(k.key)}
              className={cx("rounded-md px-3 py-1.5 text-sm font-medium", kind === k.key ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100")}
            >
              {k.label}
            </button>
          ))}
        </div>
        <select className="input w-auto py-1.5" value={state} onChange={(e) => setState(e.target.value)} aria-label="Status">
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <label className="inline-flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={due === "soon"} onChange={(e) => setDue(e.target.checked ? "soon" : "")} />
          Due soon
        </label>
        <form
          className="ml-auto w-full sm:w-64"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
          }}
        >
          <input className="input py-1.5" placeholder="Search buyer, item, order…" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setSearch(q.trim())} />
        </form>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className={cx("lg:col-span-2", selected && "hidden lg:block")}>
          {error ? (
            <Empty title="Couldn't load returns">{error.message}</Empty>
          ) : !data ? (
            <div className="flex justify-center py-16 text-slate-400">
              <Spinner />
            </div>
          ) : !data.items.length ? (
            <Empty title={state === "open" ? "Nothing open" : "Nothing here"}>
              {state === "open" ? "No returns, cancellations or cases need you right now." : "Try another filter."}
            </Empty>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                {data.items.map((c) => (
                  <Row key={c._id} c={c} active={selected?.ebayId === c.ebayId && selected.kind === c.kind} onClick={() => setSelected({ kind: c.kind, ebayId: c.ebayId })} />
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
                ← Back to the list
              </button>
              <ReturnDetail key={`${selected.kind}:${selected.ebayId}`} storeId={storeId} kind={selected.kind} ebayId={selected.ebayId} onChanged={() => mutate()} />
            </>
          ) : (
            <Empty title="Pick something on the left" />
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ c, active, onClick }: { c: PostOrderCase; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className={cx("block w-full px-4 py-3 text-left transition", active ? "bg-brand-50" : "hover:bg-slate-50")}>
        <div className="flex items-center justify-between gap-2">
          <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide", KIND_COLOR[c.kind])}>{KIND_LABEL[c.kind]}</span>
          {c.open ? <DeadlineBadge respondBy={c.respondBy} /> : <span className="text-xs text-slate-400">closed {timeAgo(c.closedAt ?? c.ebayUpdatedAt)}</span>}
        </div>
        <div className="mt-1.5 truncate text-sm font-medium text-slate-900">{c.itemTitle || `Item ${c.itemId || "—"}`}</div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-slate-500">
          <span className="truncate">
            {c.buyer} · {humanize(c.status)}
          </span>
          {c.amount && <span className="shrink-0 font-medium text-slate-700">{money(c.amount.value, c.amount.currency)}</span>}
        </div>
      </button>
    </li>
  );
}
