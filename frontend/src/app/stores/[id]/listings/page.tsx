"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "@/components/toast";
import { Button, Card, Empty, Pagination, Spinner } from "@/components/ui";
import { api, fetcher, money, timeAgo } from "@/lib/api";
import type { Listing, Paged } from "@/lib/types";

function CostCell({ storeId, l, onSaved }: { storeId: string; l: Listing; onSaved: () => void }) {
  const [v, setV] = useState(l.cost?.toString() ?? "");
  async function save() {
    const next = v.trim() === "" ? null : Number(v);
    if (next === l.cost || (next !== null && Number.isNaN(next))) return;
    try {
      await api(`/stores/${storeId}/listings/${l.itemId}`, { method: "PATCH", body: { cost: next } });
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  return (
    <input
      className="input w-24 py-1"
      type="number"
      step="0.01"
      min="0"
      placeholder="—"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export default function ListingsPage() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("lastProcessedAt");
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [importing, setImporting] = useState(false);
  const key = `/stores/${id}/listings?page=${page}&q=${encodeURIComponent(search)}&status=${status}&sort=${sort}`;
  const { data, mutate } = useSWR<Paged<Listing>>(key, fetcher);

  async function optimize(itemId: string) {
    try {
      const r = await api<{ duplicate: boolean }>(`/stores/${id}/run`, { body: { itemIds: [itemId] } });
      toast[r.duplicate ? "info" : "success"](r.duplicate ? "A batch is already queued - try again when it finishes" : "Queued - see Batches");
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function importCosts() {
    setImporting(true);
    try {
      const r = await api<{ updated: number; unmatchedCount: number; invalid: string[] }>(`/stores/${id}/listings/costs`, { body: { csv } });
      toast.success(`${r.updated} listings updated${r.unmatchedCount ? `, ${r.unmatchedCount} ids not found` : ""}`);
      if (r.invalid.length) toast.error(`${r.invalid.length} lines had an invalid cost`);
      setCsv("");
      setShowImport(false);
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title="Listings"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setShowImport((v) => !v)}>
            Import costs (CSV)
          </Button>
        }
      >
        {showImport && (
          <div className="mb-4 rounded-lg bg-slate-50 p-4">
            <p className="mb-2 text-sm text-slate-600">
              Paste CSV with two columns: <code>id,cost</code>. <b>id</b> = eBay item ID or your SKU, <b>cost</b> = what the item costs you
              (incl. your shipping cost). With a cost, the optimizer may lower prices but never below cost + your minimum margin.
            </p>
            <textarea className="input h-32 font-mono" placeholder={"id,cost\nSKU-123,8.50\n256123456789,12.00"} value={csv} onChange={(e) => setCsv(e.target.value)} />
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={importCosts} loading={importing} disabled={!csv.trim()}>
                Import
              </Button>
            </div>
          </div>
        )}

        <form
          className="mb-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(q);
          }}
        >
          <input className="input max-w-sm" placeholder="Search title, item ID or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-44" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">All active</option>
            <option value="never">Never optimized</option>
            <option value="processed">Optimized</option>
            <option value="nocost">No cost set</option>
          </select>
          <select className="input w-44" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="lastProcessedAt">Recently optimized</option>
            <option value="sold">Most sold</option>
            <option value="price">Highest price</option>
            <option value="title">Title A–Z</option>
          </select>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        {!data ? (
          <div className="flex justify-center py-16 text-slate-400">
            <Spinner />
          </div>
        ) : !data.total ? (
          <Empty title="No listings found">If this is a new store, click “Sync listings from eBay” on the Overview tab.</Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200">
                  <tr>
                    <th className="table-th">Listing</th>
                    <th className="table-th">Price</th>
                    <th className="table-th">Sold</th>
                    <th className="table-th">Watchers</th>
                    <th className="table-th">Your cost</th>
                    <th className="table-th">Optimized</th>
                    <th className="table-th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((l) => (
                    <tr key={l._id} className="hover:bg-slate-50">
                      <td className="table-td">
                        <div className="flex items-center gap-3">
                          <Link href={`/stores/${id}/listings/${l.itemId}`} className="shrink-0">
                            {l.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={l.imageUrl} alt="" className="h-10 w-10 rounded border border-slate-200 object-cover" />
                            ) : (
                              <div className="h-10 w-10 rounded bg-slate-100" />
                            )}
                          </Link>
                          <div className="min-w-0">
                            <Link href={`/stores/${id}/listings/${l.itemId}`} className="line-clamp-2 font-medium hover:text-brand-700 hover:underline">
                              {l.title}
                            </Link>
                            <div className="text-xs text-slate-400">
                              {l.itemId}
                              {l.sku && ` · ${l.sku}`}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="table-td">{money(l.price)}</td>
                      <td className="table-td">{l.quantitySold}</td>
                      <td className="table-td">{l.watchCount}</td>
                      <td className="table-td">
                        <CostCell storeId={id} l={l} onSaved={() => mutate()} />
                      </td>
                      <td className="table-td text-slate-500">{timeAgo(l.lastProcessedAt)}</td>
                      <td className="table-td whitespace-nowrap text-right">
                        <Link
                          href={`/stores/${id}/listings/${l.itemId}?tab=edit`}
                          className="mr-1 inline-flex rounded-md px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50"
                        >
                          Edit
                        </Link>
                        <Button size="sm" variant="ghost" onClick={() => optimize(l.itemId)}>
                          Optimize now
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
