"use client";
import { Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Badge, Button, Empty } from "@/components/ui";
import { api, money } from "@/lib/api";
import { MAX_BID, MIN_BID, statusLabel, type AdResult, type Campaign, type CampaignAd } from "@/lib/promotions";
import { ConfirmDialog } from "./ConfirmDialog";

const isoDay = (s?: string) => (s ? new Date(s).toISOString().slice(0, 10) : "");
const STARTED = new Set(["RUNNING", "PAUSED", "SYSTEM_PAUSED", "ENDING_SOON"]);
const editable = (c: Campaign) => c.status !== "ENDED" && c.status !== "DELETED";

function summarize(results: AdResult[], verb: string) {
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  toast[bad.length && !ok ? "error" : "success"](`${verb} ${ok} of ${results.length} listing${results.length === 1 ? "" : "s"}`);
  if (bad.length) toast.error(`${bad[0].listingId}: ${bad[0].error ?? "failed"}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ""}`);
}

/** "Edit" button + dialog: campaign name, start date (until it starts), end date. */
export function EditCampaignButton({ storeId, campaign, onDone }: { storeId: string; campaign: Campaign; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [start, setStart] = useState(isoDay(campaign.startDate));
  const [end, setEnd] = useState(isoDay(campaign.endDate));
  const started = STARTED.has(campaign.status);
  if (!editable(campaign)) return null;

  async function save() {
    setBusy(true);
    try {
      await api(`/stores/${storeId}/promotions/campaigns/${campaign.campaignId}`, {
        method: "PATCH",
        body: { name, startDate: started ? null : start || null, endDate: end || null, confirm: true },
      });
      toast.success("Campaign updated on eBay");
      setOpen(false);
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setName(campaign.name);
          setStart(isoDay(campaign.startDate));
          setEnd(isoDay(campaign.endDate));
          setOpen(true);
        }}
      >
        <Pencil className="h-4 w-4" /> Edit campaign
      </Button>
      <ConfirmDialog open={open} title="Edit campaign" confirmLabel="Save on eBay" busy={busy} onConfirm={save} onCancel={() => setOpen(false)}>
        <label className="label">Name</label>
        <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Start date</label>
            <input className="input" type="date" value={start} disabled={started} onChange={(e) => setStart(e.target.value)} />
            {started && <p className="mt-1 text-xs text-slate-500">Already started - eBay keeps the start date.</p>}
          </div>
          <div>
            <label className="label">End date</label>
            <input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Leave empty for no end date.</p>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

/** Promoted listings with checkboxes: change ad rate (selected or all) and remove from the campaign. */
export function CampaignAdsTable({ storeId, campaign, ads, onDone }: { storeId: string; campaign: Campaign; ads: CampaignAd[]; onDone: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bid, setBid] = useState(String(campaign.bidPercentage ?? 5));
  const [action, setAction] = useState<null | "bid" | "bid-all" | "remove">(null);
  const [busy, setBusy] = useState(false);
  const canEdit = editable(campaign) && campaign.fundingModel === "COST_PER_SALE";
  const canRemove = editable(campaign) && !campaign.rulesBased;
  const ids = ads.map((a) => a.listingId).filter(Boolean) as string[];
  const bidNum = Number(bid);
  const bidOk = bidNum >= MIN_BID && bidNum <= MAX_BID;
  const all = picked.size > 0 && picked.size === ids.length;

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function run() {
    setBusy(true);
    const base = `/stores/${storeId}/promotions/campaigns/${campaign.campaignId}/ads`;
    try {
      if (action === "remove") {
        const r = await api<{ results: AdResult[] }>(`${base}/remove`, { body: { listingIds: [...picked], confirm: true } });
        summarize(r.results, "Removed");
      } else {
        const body = action === "bid-all" ? { all: true, bidPercentage: bidNum, confirm: true } : { listingIds: [...picked], bidPercentage: bidNum, confirm: true };
        const r = await api<{ results: AdResult[] }>(`${base}/bid`, { body });
        summarize(r.results, `Ad rate ${bidNum}% set on`);
      }
      setPicked(new Set());
      setAction(null);
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!ads.length) return <Empty title="No listings in this campaign yet" />;

  return (
    <div className="space-y-3">
      {(canEdit || canRemove) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-600">{picked.size ? `${picked.size} selected` : "Select listings to change them"}</span>
          {canEdit && (
            <>
              <span className="ml-auto flex items-center gap-1">
                <input
                  className="input w-20 py-1 text-right"
                  type="number"
                  step="0.1"
                  min={MIN_BID}
                  max={MAX_BID}
                  value={bid}
                  onChange={(e) => setBid(e.target.value)}
                  aria-label="Ad rate percent"
                />
                %
              </span>
              <Button size="sm" variant="secondary" disabled={!picked.size || !bidOk} onClick={() => setAction("bid")}>
                Set rate for selected
              </Button>
              <Button size="sm" variant="secondary" disabled={!bidOk} onClick={() => setAction("bid-all")}>
                Set rate for all {ids.length}
              </Button>
            </>
          )}
          {canRemove && (
            <Button size="sm" variant="danger" disabled={!picked.size} onClick={() => setAction("remove")}>
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
          {canEdit && !bidOk && <span className="w-full text-xs text-rose-600">Ad rate must be {MIN_BID}-{MAX_BID}%</span>}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {(canEdit || canRemove) && (
                <th className="w-8 py-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={all}
                    onChange={() => setPicked(all ? new Set() : new Set(ids))}
                    aria-label="Select all"
                  />
                </th>
              )}
              <th className="py-2 pr-3">Listing</th>
              <th className="py-2 pr-3 text-right">Price</th>
              <th className="py-2 pr-3 text-right">Ad rate</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ads.map((a) => (
              <tr key={a.adId} className={a.listingId && picked.has(a.listingId) ? "bg-brand-50/50" : ""}>
                {(canEdit || canRemove) && (
                  <td className="py-2">
                    {a.listingId && (
                      <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={picked.has(a.listingId)} onChange={() => toggle(a.listingId!)} />
                    )}
                  </td>
                )}
                <td className="py-2 pr-3">
                  {a.listingId ? (
                    <Link href={`/stores/${storeId}/listings/${a.listingId}`} className="text-slate-800 hover:underline">
                      {a.title ?? a.listingId}
                    </Link>
                  ) : (
                    "—"
                  )}
                  <div className="font-mono text-xs text-slate-400">{a.listingId}</div>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(a.price)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{a.bidPercentage !== null ? `${a.bidPercentage}%` : "—"}</td>
                <td className="py-2">
                  <Badge color={a.status === "ACTIVE" ? "green" : "gray"}>{statusLabel(a.status)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={action !== null}
        title={action === "remove" ? "Remove listings from this campaign?" : "Change ad rate?"}
        confirmLabel={action === "remove" ? `Remove ${picked.size}` : `Set ${bidNum}%`}
        danger={action === "remove"}
        busy={busy}
        onConfirm={run}
        onCancel={() => setAction(null)}
      >
        {action === "remove" ? (
          <p>
            {picked.size} listing{picked.size === 1 ? "" : "s"} will stop being promoted in <b>{campaign.name}</b>. The listings themselves stay live.
          </p>
        ) : (
          <p>
            eBay will charge <b>{bidNum}%</b> of the sale price when a sale comes from this ad, for{" "}
            {action === "bid-all" ? `all ${ids.length} listings` : `${picked.size} selected listing${picked.size === 1 ? "" : "s"}`} in{" "}
            <b>{campaign.name}</b>.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
