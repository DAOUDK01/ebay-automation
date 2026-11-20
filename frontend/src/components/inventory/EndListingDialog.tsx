"use client";
import { useState } from "react";
import { Modal } from "@/components/feedback/Modal";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { END_REASONS, type EndReason, type InventoryItem } from "@/lib/inventory";

/** End a live listing early, with the reason eBay asks for. Confirmed twice: the dialog, then a final confirm. */
export function EndListingDialog({ storeId, item, onClose, onDone }: { storeId: string; item: InventoryItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<EndReason>("NotAvailable");
  const [busy, setBusy] = useState(false);
  async function end() {
    if (!confirm(`End "${item.title}" on eBay now?\n\nBuyers won't be able to purchase it. You can relist it later from Ended / unsold.`)) return;
    setBusy(true);
    try {
      await api(`/stores/${storeId}/inventory/${item.itemId}/end`, { body: { reason } });
      toast.success("Listing ended");
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="End listing"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={end} loading={busy}>
            End listing
          </Button>
        </>
      }
    >
      <p className="font-medium text-slate-800">{item.title}</p>
      <p className="text-xs text-slate-500">
        Item {item.itemId}
        {item.watchers ? ` · ${item.watchers} watching` : ""}
      </p>
      <div>
        <label className="label" htmlFor="end-reason">
          Reason
        </label>
        <select id="end-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as EndReason)}>
          {END_REASONS.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}
