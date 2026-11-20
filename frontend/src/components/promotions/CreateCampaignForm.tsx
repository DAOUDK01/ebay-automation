"use client";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { MAX_BID, MIN_BID, type Campaign } from "@/lib/promotions";
import { ConfirmDialog } from "./ConfirmDialog";

const today = () => new Date().toISOString().slice(0, 10);

/** New Promoted Listings Standard campaign (cost per sale). Sent to eBay only after the confirm dialog. */
export function CreateCampaignForm({ storeId, onCreated, onClose }: { storeId: string; onCreated: (c: Campaign | null) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [bid, setBid] = useState("5");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const bidNum = Number(bid);
  const valid = name.trim().length > 0 && name.trim().length <= 80 && bidNum >= MIN_BID && bidNum <= MAX_BID && !!start && (!end || end > start);

  async function create() {
    setBusy(true);
    try {
      const r = await api<{ campaign: Campaign | null }>(`/stores/${storeId}/promotions/campaigns`, {
        body: { name: name.trim(), bidPercentage: bidNum, startDate: start, endDate: end || null, confirm: true },
      });
      toast.success(`Campaign "${name.trim()}" created on eBay`);
      setConfirming(false);
      onCreated(r.campaign);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <form
      className="grid gap-3 rounded-lg bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) setConfirming(true);
      }}
    >
      <label className="text-xs font-medium text-slate-600 sm:col-span-2 lg:col-span-1">
        Campaign name
        <input className="input mt-1" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brakes - winter" required />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Ad rate (% of sale)
        <input className="input mt-1" type="number" min={MIN_BID} max={MAX_BID} step="0.1" value={bid} onChange={(e) => setBid(e.target.value)} required />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Start date
        <input className="input mt-1" type="date" min={today()} value={start} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <label className="text-xs font-medium text-slate-600">
        End date (optional)
        <input className="input mt-1" type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2 lg:col-span-4">
        <p className="text-xs text-slate-500">
          Promoted Listings Standard: you pay the ad rate only when a buyer clicks your ad and buys within 30 days. Add listings after it&apos;s
          created.
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid}>
            Create campaign…
          </Button>
        </div>
      </div>
    </form>
      <ConfirmDialog
        open={confirming}
        title="Create this campaign on eBay?"
        confirmLabel="Create campaign"
        busy={busy}
        onConfirm={create}
        onCancel={() => setConfirming(false)}
      >
        <p>
          <b>{name.trim()}</b> - Promoted Listings Standard, cost per sale, default ad rate <b>{bidNum}%</b>.
        </p>
        <p>
          Starts {start === today() ? "right away" : start}
          {end ? `, ends ${end}` : ", runs until you end it"}.
        </p>
        <p>The campaign has no listings until you add some, so nothing is charged yet.</p>
      </ConfirmDialog>
    </>
  );
}
