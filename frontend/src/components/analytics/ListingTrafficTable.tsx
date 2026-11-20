"use client";
import { WandSparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api, money, timeAgo } from "@/lib/api";
import type { ListingTrafficRow } from "@/lib/analytics";

const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(n < 10 ? 1 : 0)}%`);

function Title({ storeId, r }: { storeId: string; r: ListingTrafficRow }) {
  return (
    <div className="min-w-0">
      <Link href={`/stores/${storeId}/listings/${r.itemId}`} className="line-clamp-1 font-medium text-slate-800 hover:underline">
        {r.title ?? `Item ${r.itemId}`}
      </Link>
      <div className="text-xs text-slate-500">
        <span className="font-mono">{r.itemId}</span>
        {r.price !== null && ` · ${money(r.price)}`}
        {r.active === false && " · ended"}
      </div>
    </div>
  );
}

/** Top listings by traffic. */
export function TopListingsTable({ storeId, rows }: { storeId: string; rows: ListingTrafficRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 pr-3">Listing</th>
            <th className="py-2 pr-3 text-right">Impressions</th>
            <th className="py-2 pr-3 text-right">Views</th>
            <th className="py-2 pr-3 text-right">Click-through</th>
            <th className="py-2 pr-3 text-right">Sales</th>
            <th className="py-2 text-right">Conversion</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.itemId}>
              <td className="max-w-xs py-2 pr-3">
                <Title storeId={storeId} r={r} />
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.impressions.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.views.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{pct(r.ctr)}</td>
              <td className="py-2 pr-3 text-right tabular-nums font-medium">{r.transactions}</td>
              <td className="py-2 text-right tabular-nums text-slate-600">{pct(r.conversion)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Listings people look at but don't buy - each with a one-click "Optimize" (queues the AI optimizer). */
export function NoSalesList({ storeId, rows }: { storeId: string; rows: ListingTrafficRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function optimize(itemId: string) {
    setBusy(itemId);
    try {
      const r = await api<{ duplicate: boolean }>(`/stores/${storeId}/run`, { body: { itemIds: [itemId] } });
      toast[r.duplicate ? "info" : "success"](r.duplicate ? "A batch is already queued - try again when it finishes" : "Queued - results appear in Review & batches");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.itemId} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <Title storeId={storeId} r={r} />
            <div className="mt-0.5 text-xs text-slate-500">
              <b className="text-slate-700">{r.views.toLocaleString()} views</b>, {r.impressions.toLocaleString()} impressions, no sales
              {r.lastOptimizedAt ? ` · optimized ${timeAgo(r.lastOptimizedAt)}` : " · never optimized"}
            </div>
          </div>
          <Link href={`/stores/${storeId}/listings/${r.itemId}`} className="text-sm text-slate-600 hover:text-slate-900">
            Open
          </Link>
          <Button size="sm" variant="secondary" loading={busy === r.itemId} onClick={() => optimize(r.itemId)}>
            {busy !== r.itemId && <WandSparkles className="h-3.5 w-3.5" />}
            Optimize
          </Button>
        </li>
      ))}
    </ul>
  );
}
