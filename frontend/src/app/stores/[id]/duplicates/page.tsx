"use client";
import { EyeOff, ExternalLink, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ConfirmDialog } from "@/components/promotions/ConfirmDialog";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Empty, Spinner, Stat, cx } from "@/components/ui";
import { api, fetcher, money } from "@/lib/api";

interface DupListing {
  itemId: string;
  title: string;
  sku?: string | null;
  price?: number | null;
  quantitySold?: number | null;
  watchCount?: number | null;
  imageUrl?: string | null;
  quantityAvailable?: number | null;
}
interface DupGroup {
  key: string;
  reasons: ("sku" | "title" | "part_number")[];
  confidence: "high" | "medium";
  matches: string[];
  keepItemId: string;
  listings: DupListing[];
}
interface DupResponse {
  groups: DupGroup[];
  scanned: number;
  ignoredCount: number;
  totals: { groups: number; extraListings: number };
}

const REASON: Record<string, string> = { sku: "Same SKU", title: "Same title", part_number: "Same part number" };

export default function DuplicatesPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, mutate, isLoading } = useSWR<DupResponse>(`/stores/${id}/inventory/duplicates`, fetcher, { revalidateOnFocus: false });
  const [filter, setFilter] = useState<"all" | "high" | "medium">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // pre-select every copy except the suggested keeper
  useEffect(() => {
    if (!data) return;
    setPicked(new Set(data.groups.flatMap((g) => g.listings.filter((l) => l.itemId !== g.keepItemId).map((l) => l.itemId))));
  }, [data]);

  const groups = useMemo(() => (data?.groups ?? []).filter((g) => filter === "all" || g.confidence === filter), [data, filter]);
  const selectedVisible = groups.flatMap((g) => g.listings.filter((l) => picked.has(l.itemId)).map((l) => l.itemId));

  const toggle = (itemId: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(itemId)) n.delete(itemId);
      else n.add(itemId);
      return n;
    });

  /** a selection that ends every copy of an item is refused (by the server too) */
  const wholeGroup = (ids: string[]) => groups.some((g) => g.listings.every((l) => ids.includes(l.itemId)));

  async function end(ids: string[]) {
    setBusy(true);
    try {
      const r = await api<{ ended: number; results: { itemId: string; ok: boolean; error?: string }[] }>(`/stores/${id}/inventory/duplicates/end`, {
        body: { itemIds: ids, confirm: true },
      });
      const failed = r.results.filter((x) => !x.ok);
      toast[failed.length && !r.ended ? "error" : "success"](`Ended ${r.ended} duplicate listing${r.ended === 1 ? "" : "s"} on eBay`);
      if (failed.length) toast.error(`${failed[0].itemId}: ${failed[0].error}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ""}`);
      setConfirming(null);
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function ignore(key: string) {
    try {
      await api(`/stores/${id}/inventory/duplicates/ignore`, { body: { key } });
      toast.info("Hidden - this group won't show again");
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  if (error) return <Alert>{error.message}</Alert>;
  if (isLoading || !data)
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Spinner />
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Duplicate groups" value={data.totals.groups} hint={`${data.scanned.toLocaleString()} active listings checked`} />
        <Stat label="Extra copies" value={data.totals.extraListings} hint="Listings beyond one per item" />
        <Stat label="Selected to end" value={picked.size} />
        <Stat label="Hidden groups" value={data.ignoredCount} hint="Marked “not duplicates”" />
      </div>

      <Alert kind="info">
        Listings are grouped when they share a <b>SKU</b>, an <b>identical title</b> or a <b>part number</b>. Used parts with the same part number
        can be different physical pieces - check photos and condition before ending &ldquo;Same part number&rdquo; groups. The listing with the
        most sales (then watchers) is kept by default; ended listings can be relisted from Inventory.
      </Alert>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
          {(["all", "high", "medium"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={cx("px-3 py-1.5 font-medium", filter === f ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50")}>
              {f === "all" ? "All" : f === "high" ? "Same SKU / title" : "Same part number"}
            </button>
          ))}
        </div>
        <Button
          variant="danger"
          className="ml-auto"
          disabled={!selectedVisible.length || wholeGroup(selectedVisible)}
          onClick={() => setConfirming(selectedVisible)}
        >
          <Trash2 className="h-4 w-4" /> End {selectedVisible.length} selected
        </Button>
      </div>
      {wholeGroup(selectedVisible) && <p className="text-sm text-rose-600">Keep at least one listing in every group.</p>}

      {!groups.length ? (
        <Empty title="No duplicate listings found">Every active listing looks unique{data.ignoredCount ? " (some groups are hidden)" : ""}.</Empty>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const sel = g.listings.filter((l) => picked.has(l.itemId)).map((l) => l.itemId);
            return (
              <div key={g.key} className="rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
                  <Badge color={g.confidence === "high" ? "red" : "yellow"}>{g.confidence === "high" ? "Likely duplicate" : "Check"}</Badge>
                  {g.reasons.map((r) => (
                    <Badge key={r} color="gray">
                      {REASON[r]}
                    </Badge>
                  ))}
                  <span className="truncate text-xs text-slate-500">{g.matches.join(" · ")}</span>
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => ignore(g.key)}>
                      <EyeOff className="h-3.5 w-3.5" /> Not duplicates
                    </Button>
                    <Button size="sm" variant="danger" disabled={!sel.length || sel.length === g.listings.length} onClick={() => setConfirming(sel)}>
                      End {sel.length}
                    </Button>
                  </div>
                </div>
                <ul className="divide-y divide-slate-100">
                  {g.listings.map((l) => {
                    const keep = l.itemId === g.keepItemId;
                    return (
                      <li key={l.itemId} className={cx("flex items-center gap-3 px-4 py-2.5 text-sm", picked.has(l.itemId) && "bg-rose-50/50")}>
                        <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={picked.has(l.itemId)} onChange={() => toggle(l.itemId)} aria-label={`End ${l.itemId}`} />
                        {l.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={l.imageUrl} alt="" className="h-11 w-11 shrink-0 rounded border border-slate-200 object-cover" />
                        ) : (
                          <div className="h-11 w-11 shrink-0 rounded bg-slate-100" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={`/stores/${id}/listings/${l.itemId}`} className="line-clamp-1 font-medium text-slate-800 hover:underline">
                              {l.title}
                            </Link>
                            {keep && <Badge color="green">Keep</Badge>}
                          </div>
                          <div className="text-xs text-slate-500">
                            {l.itemId}
                            {l.sku ? ` · SKU ${l.sku}` : ""} · {l.quantitySold ?? 0} sold · {l.watchCount ?? 0} watching
                            {typeof l.quantityAvailable === "number" ? ` · ${l.quantityAvailable} available` : ""}
                          </div>
                        </div>
                        <div className="text-right tabular-nums">{money(l.price ?? 0)}</div>
                        <a
                          href={`https://www.ebay.com/itm/${l.itemId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-400 hover:text-slate-700"
                          title="View on eBay"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={`End ${confirming?.length ?? 0} duplicate listing${confirming?.length === 1 ? "" : "s"} on eBay?`}
        confirmLabel="End listings"
        danger
        busy={busy}
        onConfirm={() => confirming && end(confirming)}
        onCancel={() => setConfirming(null)}
      >
        <p>
          These listings will be ended on eBay now (reason: listing error / duplicate). The kept copy of each item stays live. Ended listings can be
          relisted later from Inventory.
        </p>
      </ConfirmDialog>
    </div>
  );
}
