"use client";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { CARRIERS, type Order } from "@/lib/orders";
import { Field, Modal } from "./Modal";

/** today's date in the user's time zone, yyyy-mm-dd */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Shared by the dialog and the inline queue row: confirm, then upload one tracking number to eBay. */
export async function uploadTracking(storeId: string, order: Pick<Order, "orderId" | "buyer">, carrier: string, trackingNumber: string, shippedDate?: string) {
  if (!carrier.trim() || !trackingNumber.trim()) {
    toast.error("Enter a carrier and a tracking number");
    return null;
  }
  if (!confirm(`Upload ${carrier} tracking ${trackingNumber.trim()} to eBay for order ${order.orderId}? eBay marks the order shipped and emails ${order.buyer.username || "the buyer"}.`)) return null;
  try {
    const r = await api<{ order: Order }>(`/stores/${storeId}/orders/${encodeURIComponent(order.orderId)}/tracking`, {
      body: { carrier, trackingNumber, ...(shippedDate && shippedDate !== today() ? { shippedDate: new Date(`${shippedDate}T12:00:00`).toISOString() } : {}) },
    });
    toast.success(`Tracking uploaded for ${order.orderId}`);
    return r.order;
  } catch (e: any) {
    toast.error(e.message);
    return null;
  }
}

export function TrackingDialog({ storeId, order, onClose, onDone }: { storeId: string; order: Order; onClose: () => void; onDone: (o: Order) => void }) {
  const [carrier, setCarrier] = useState("USPS");
  const [tracking, setTracking] = useState("");
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const unshipped = order.lineItems.filter((l) => l.fulfillmentStatus !== "FULFILLED");

  async function submit() {
    setBusy(true);
    const o = await uploadTracking(storeId, order, carrier, tracking, date);
    setBusy(false);
    if (o) onDone(o);
  }

  return (
    <Modal
      title={`Add tracking · ${order.orderId}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!tracking.trim()}>
            Upload to eBay
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Carrier">
          <input className="input" list="carrier-options" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
          <datalist id="carrier-options">
            {CARRIERS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Tracking number">
          <input className="input font-mono" autoFocus value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="1Z999AA10123456784" />
        </Field>
        <Field label="Shipped on">
          <input className="input" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <p className="text-xs text-slate-500">
          Covers {unshipped.length || order.lineItems.length} line item{(unshipped.length || order.lineItems.length) === 1 ? "" : "s"}:{" "}
          {(unshipped.length ? unshipped : order.lineItems).map((l) => `${l.qty}× ${l.title}`).join("; ")}
        </p>
      </div>
    </Modal>
  );
}
