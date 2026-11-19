"use client";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { EndListingDialog } from "@/components/inventory/EndListingDialog";
import { InventoryTable, toChange, type Edits } from "@/components/inventory/InventoryTable";
import { toast } from "@/components/toast";
import { Alert, Button, Card, cx, Empty, Pagination, Spinner } from "@/components/ui";
import { api, fetcher, money } from "@/lib/api";
import { INVENTORY_TABS, type InventoryItem, type InventoryPage, type InventoryTab, type ReviseResult, type StockChange } from "@/lib/inventory";

export default function InventoryPageView() {
  const { id } = useParams<{ id: string }>();
  const { mutate: globalMutate } = useSWRConfig();
  const [tab, setTab] = useState<InventoryTab>("out");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [edits, setEdits] = useState<Edits>({});
  const known = useRef<Record<string, InventoryItem>>({});
  const [results, setResults] = useState<Record<string, ReviseResult>>({});
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState<InventoryItem | null>(null);
  const [relisting, setRelisting] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<string | null>(null);
  const key = `/stores/${id}/inventory?tab=${tab}&q=${encodeURIComponent(search)}&page=${page}`;
  const { data, error, mutate } = useSWR<InventoryPage>(key, fetcher, { keepPreviousData: true });

  for (const it of data?.items ?? []) known.current[it.itemId] = it;
  const changes = Object.entries(edits)
    .map(([itemId, e]) => (known.current[itemId] ? toChange(known.current[itemId], e) : null))
    .filter((c): c is StockChange => !!c);

  const refresh = () => {
    mutate();
    globalMutate(`/stores/${id}/counts`);
  };

  function setEdit(itemId: string, field: "quantity" | "price", v: string) {
    setEdits((e) => ({ ...e, [itemId]: { ...e[itemId], [field]: v } }));
    setResults((r) => {
      const { [itemId]: _drop, ...rest } = r;
      return rest;
    });
  }

  async function save() {
    const lines = changes.map((c) => {
      const it = known.current[c.itemId];
      const parts = [
        c.quantity !== undefined && `qty ${it.quantityAvailable} → ${c.quantity}`,
        c.price !== undefined && `price ${money(it.price, it.currency)} → ${money(c.price, it.currency)}`,
      ].filter(Boolean);
      return `• ${it.title.slice(0, 50)}: ${parts.join(", ")}`;
    });
    const shown = lines.slice(0, 12).join("\n") + (lines.length > 12 ? `\n…and ${lines.length - 12} more` : "");
    if (!confirm(`Update ${changes.length} listing(s) on eBay now?\n\n${shown}`)) return;
    setSaving(true);
    try {
      const r = await api<{ results: ReviseResult[]; ok: number; failed: number }>(`/stores/${id}/inventory/revise`, { body: { changes } });
      setResults(Object.fromEntries(r.results.map((x) => [x.itemId, x])));
      // keep failed edits so they can be fixed and retried
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([itemId]) => !r.results.find((x) => x.itemId === itemId)?.ok)));
      if (r.failed) toast.error(`${r.ok} updated, ${r.failed} failed - see the rows marked in red`);
      else toast.success(`${r.ok} listing(s) updated on eBay`);
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function relist(it: InventoryItem) {
    if (!confirm(`Relist "${it.title}" on eBay?\n\nA new listing is created with the same details and eBay's insertion fees apply.`)) return;
    setRelisting(it.itemId);
    try {
      const r = await api<{ newItemId: string }>(`/stores/${id}/inventory/${it.itemId}/relist`, { body: {} });
      toast.success(`Relisted as item ${r.newItemId}`);
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRelisting(null);
    }
  }

  async function saveThreshold() {
    const n = Number(threshold);
    if (!Number.isInteger(n) || n < 0) return toast.error("Enter a whole number, 0 or more");
    try {
      await api(`/stores/${id}/inventory/settings`, { method: "PUT", body: { lowStockThreshold: n } });
      toast.success(`Low stock = ${n} or fewer available`);
      setThreshold(null);
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error.message}</Alert>}
      <Card
        title="Inventory"
        actions={
          <>
            <span className="text-xs text-slate-500">Low stock at</span>
            <input
              className="input w-16 py-1"
              type="number"
              min="0"
              aria-label="Low stock threshold"
              value={threshold ?? String(data?.lowStockThreshold ?? 1)}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <span className="text-xs text-slate-500">or fewer</span>
            {threshold !== null && (
              <Button size="sm" variant="secondary" onClick={saveThreshold}>
                Save
              </Button>
            )}
          </>
        }
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-slate-100">
          <nav className="-mb-px flex gap-1 overflow-x-auto">
            {INVENTORY_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => (setTab(t.key), setSearch(""), setQ(""), setPage(1))}
                className={cx(
                  "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition",
                  tab === t.key && !search ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
                )}
              >
                {t.label}
                {data && (
                  <span className={cx("ml-1.5 rounded-full px-1.5 text-xs", t.key === "out" && data.tabs.out ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600")}>
                    {data.tabs[t.key]}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <form
            className="mb-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setSearch(q.trim());
            }}
          >
            <input className="input w-60 py-1.5" placeholder="Search SKU, title or item ID" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" size="sm" variant="secondary">
              Search
            </Button>
          </form>
        </div>

        {search && (
          <div className="mb-3 flex items-center gap-2 text-sm text-slate-600">
            Results for “{search}” across all listings
            <Button size="sm" variant="ghost" onClick={() => (setSearch(""), setQ(""))}>
              Clear
            </Button>
          </div>
        )}

        {!data ? (
          <div className="flex justify-center py-16 text-slate-400">
            <Spinner />
          </div>
        ) : !data.total ? (
          <Empty title={search ? "Nothing matches" : tab === "out" ? "Nothing is out of stock" : tab === "low" ? "No low stock" : "No listings here"}>
            {search ? "Try another SKU or word from the title." : "Stock levels refresh with the account sync."}
          </Empty>
        ) : (
          <>
            <InventoryTable
              items={data.items}
              threshold={data.lowStockThreshold}
              edits={edits}
              setEdit={setEdit}
              results={results}
              onEnd={setEnding}
              onRelist={relist}
              relisting={relisting}
            />
            <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      {changes.length > 0 && (
        <div className="sticky bottom-4 z-30 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3 shadow-lg">
          <span className="text-sm text-amber-900">
            {changes.length} unsaved change{changes.length === 1 ? "" : "s"} — sent to eBay 4 listings per call
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => (setEdits({}), setResults({}))} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" onClick={save} loading={saving}>
              Save changes
            </Button>
          </div>
        </div>
      )}

      {ending && (
        <EndListingDialog
          storeId={id}
          item={ending}
          onClose={() => setEnding(null)}
          onDone={() => {
            setEnding(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
