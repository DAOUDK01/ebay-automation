"use client";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Alert, Button, cx } from "@/components/ui";
import { api, money } from "@/lib/api";
import { REFUND_REASONS, type Order } from "@/lib/orders";
import { Field, Modal } from "./Modal";

export function RefundDialog({
  storeId,
  order,
  refundable,
  onClose,
  onDone,
}: {
  storeId: string;
  order: Order;
  refundable: number;
  onClose: () => void;
  onDone: (o: Order) => void;
}) {
  const [kind, setKind] = useState<"full" | "partial">("full");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("BUYER_CANCEL");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const cur = order.totals.currency;
  const value = kind === "full" ? refundable : Number(amount);
  const valid = value > 0 && value <= refundable + 1e-9;

  async function submit() {
    if (!valid) return;
    const label = REFUND_REASONS.find((r) => r.value === reason)?.label ?? reason;
    if (!confirm(`Refund ${money(value, cur)} to ${order.buyer.username || "the buyer"} for order ${order.orderId}?\nReason: ${label}\n\nThis sends the money back through eBay and can't be undone.`)) return;
    setBusy(true);
    try {
      const r = await api<{ order: Order; refundStatus: string }>(`/stores/${storeId}/orders/${encodeURIComponent(order.orderId)}/refund`, {
        body: { kind, ...(kind === "partial" ? { amount: Number(amount) } : {}), reason, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      });
      toast.success(`Refund of ${money(value, cur)} issued (${r.refundStatus.toLowerCase()})`);
      onDone(r.order);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Refund · ${order.orderId}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} loading={busy} disabled={!valid}>
            Refund {valid ? money(value, cur) : ""}
          </Button>
        </>
      }
    >
      {refundable <= 0 ? (
        <Alert kind="info">This order has already been fully refunded.</Alert>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {(["full", "partial"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cx(
                  "rounded-lg border px-3 py-2 text-left text-sm",
                  kind === k ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-600 hover:bg-slate-50",
                )}
              >
                <div className="font-medium">{k === "full" ? "Full refund" : "Partial refund"}</div>
                <div className="text-xs opacity-80">{k === "full" ? money(refundable, cur) : "Enter an amount"}</div>
              </button>
            ))}
          </div>
          {kind === "partial" && (
            <Field label="Amount" hint={`Up to ${money(refundable, cur)}`}>
              <input className="input" type="number" min="0.01" step="0.01" max={refundable} autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          )}
          <Field label="Reason">
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REFUND_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note to buyer (optional)">
            <input className="input" maxLength={100} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
