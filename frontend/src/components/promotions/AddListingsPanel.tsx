"use client";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "@/components/toast";
import { Badge, Button, Empty, Spinner } from "@/components/ui";
import { api, fetcher, money } from "@/lib/api";
import { MAX_BID, MIN_BID, type AdResult, type Campaign, type PromotableListing } from "@/lib/promotions";
import { ConfirmDialog } from "./ConfirmDialog";

/** Search this account's listings, tick some, set an ad rate, confirm -> bulk_create_ads_by_listing_id. */
export function AddListingsPanel({ storeId, campaign, onAdded }: { storeId: string; campaign: Campaign; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Map<string, PromotableListing>>(new Map());
  const [bid, setBid] = useState(String(campaign.bidPercentage ?? 5));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<AdResult[] | null>(null);
  const { data } = useSWR<{ listings: PromotableListing[] }>(`/stores/${storeId}/promotions/listing-search?q=${encodeURIComponent(search)}`, fetcher);
  const bidNum = Number(bid);
  const bidOk = bidNum >= MIN_BID && bidNum <= MAX_BID;

  const toggle = (l: PromotableListing) =>
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(l.itemId)) n.delete(l.itemId);
      else n.set(l.itemId, l);
      return n;
    });

  async function add() {
    setBusy(true);
    try {
      const r = await api<{ results: AdResult[] }>(`/stores/${storeId}/promotions/campaigns/${campaign.campaignId}/ads`, {
        body: { listingIds: [...picked.keys()], bidPercentage: bidNum, confirm: true },
      });
      const ok = r.results.filter((x) => x.ok).length;
      toast[ok ? "success" : "error"](`${ok} of ${r.results.length} listings added`);
      setResults(r.results);
      setPicked(new Map());
      setConfirming(false);
      onAdded();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
        }}
      >
        <input className="input max-w-sm flex-1" placeholder="Search title, item ID or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {!data ? (
        <div className="flex justify-center py-6 text-slate-400">
          <Spinner />
        </div>
      ) : !data.listings.length ? (
        <Empty title="No active listings match" />
      ) : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {data.listings.map((l) => {
            const here = l.campaignId === campaign.campaignId;
            const elsewhere = !!l.campaignId && !here;
            return (
              <li key={l.itemId}>
                <label className={`flex items-center gap-3 px-3 py-2 text-sm ${here ? "opacity-60" : "cursor-pointer hover:bg-slate-50"}`}>
                  <input type="checkbox" disabled={here} checked={picked.has(l.itemId)} onChange={() => toggle(l)} className="h-4 w-4 rounded border-slate-300" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-slate-800">{l.title}</span>
                    <span className="text-xs text-slate-500">
                      <span className="font-mono">{l.itemId}</span>
                      {l.price !== undefined && ` · ${money(l.price)}`}
                      {l.quantitySold ? ` · ${l.quantitySold} sold` : ""}
                    </span>
                  </span>
                  {here && <Badge color="green">In this campaign</Badge>}
                  {elsewhere && <Badge color="yellow">In another campaign</Badge>}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-600">
          Ad rate (% of sale)
          <input className="input mt-1 w-32" type="number" min={MIN_BID} max={MAX_BID} step="0.1" value={bid} onChange={(e) => setBid(e.target.value)} />
        </label>
        <Button disabled={!picked.size || !bidOk} onClick={() => setConfirming(true)}>
          Add {picked.size || ""} listing{picked.size === 1 ? "" : "s"}…
        </Button>
        {!bidOk && <span className="text-xs text-rose-600">Ad rate must be {MIN_BID}-{MAX_BID}%</span>}
      </div>

      {results && results.some((r) => !r.ok) && (
        <ul className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {results
            .filter((r) => !r.ok)
            .map((r) => (
              <li key={r.listingId}>
                <span className="font-mono">{r.listingId}</span>: {r.error}
              </li>
            ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Promote ${picked.size} listing${picked.size === 1 ? "" : "s"}?`}
        confirmLabel="Add to campaign"
        busy={busy}
        onConfirm={add}
        onCancel={() => setConfirming(false)}
      >
        <p>
          Adds them to <b>{campaign.name}</b> at an ad rate of <b>{bidNum}%</b>. When a promoted listing sells through its ad, eBay charges{" "}
          {bidNum}% of the sale total.
        </p>
        <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-xs">
          {[...picked.values()].map((l) => (
            <li key={l.itemId}>{l.title}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
