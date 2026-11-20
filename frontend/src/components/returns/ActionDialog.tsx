"use client";
import { useEffect, useState } from "react";
import { mutate as globalMutate } from "swr";
import { toast } from "@/components/toast";
import { Alert, Button } from "@/components/ui";
import { api, money } from "@/lib/api";
import { KIND_LABEL, type PostOrderCase } from "@/lib/returns";
import { Modal } from "./Modal";

interface Spec {
  title: string;
  /** what happens on eBay - shown above the confirm button */
  effect: (c: PostOrderCase) => string;
  confirm: string;
  variant: "primary" | "danger" | "success";
}

const SPECS: Record<string, Spec> = {
  approve: {
    title: "Approve",
    effect: (c) =>
      c.kind === "cancellation"
        ? `eBay cancels order ${c.orderId || c.ebayId} and refunds ${c.buyer}${c.amount ? ` ${money(c.amount.value, c.amount.currency)}` : ""}. Don't ship the item.`
        : `eBay tells ${c.buyer} the return is accepted and gives them return instructions.`,
    confirm: "Yes, approve",
    variant: "success",
  },
  decline: {
    title: "Decline the return",
    effect: (c) => `eBay tells ${c.buyer} you declined. They can still ask eBay to step in, so give a clear reason.`,
    confirm: "Yes, decline",
    variant: "danger",
  },
  reject: {
    title: "Reject the cancellation",
    effect: (c) => `The order stays active. eBay tells ${c.buyer} it has already shipped.`,
    confirm: "Yes, reject",
    variant: "danger",
  },
  refund: {
    title: "Issue a refund",
    effect: (c) => `eBay refunds ${c.buyer} from your funds right away. This can't be undone.`,
    confirm: "Yes, send the refund",
    variant: "danger",
  },
  mark_received: {
    title: "Mark the item as received",
    effect: () => "eBay records that the returned item reached you. Refund it after checking the item.",
    confirm: "Yes, mark received",
    variant: "primary",
  },
  message: {
    title: "Message the buyer",
    effect: (c) => `${c.buyer} receives this message on eBay.`,
    confirm: "Send message",
    variant: "primary",
  },
  tracking: {
    title: "Send tracking to the case",
    effect: () => "eBay adds this tracking to the case as proof of shipment.",
    confirm: "Yes, send tracking",
    variant: "primary",
  },
};

/**
 * Collects what an action needs and asks the user to confirm. The request is sent only from the
 * confirm button (`confirm: true`) - never automatically.
 */
export function ActionDialog({
  storeId,
  item,
  action,
  onClose,
  onDone,
}: {
  storeId: string;
  item: PostOrderCase;
  action: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [shippedDate, setShippedDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setNote("");
    setAmount(item.amount ? item.amount.value.toFixed(2) : "");
    setCarrier("");
    setTracking("");
    setShippedDate("");
    setError("");
  }, [action, item]);

  if (!action) return null;
  const spec = SPECS[action] ?? { title: action, effect: () => "", confirm: "Confirm", variant: "primary" as const };
  const isCaseRefund = item.kind === "case" && action === "refund";
  const currency = item.amount?.currency ?? "USD";
  const amountNum = Number(amount);

  const body = (() => {
    if (action === "refund" && !isCaseRefund) return { amount: amountNum, currency, note };
    if (action === "message") return { text: note };
    if (action === "tracking") return { carrier, trackingNumber: tracking, shippedDate: shippedDate || undefined };
    if (action === "reject") return { trackingNumber: tracking || undefined, shippedDate: shippedDate || undefined };
    if (item.kind === "cancellation" && action === "approve") return {};
    return { note: note || undefined };
  })();

  const invalid =
    (action === "decline" && !note.trim()) ||
    (action === "message" && !note.trim()) ||
    (action === "tracking" && (!carrier.trim() || !tracking.trim())) ||
    (action === "refund" && !isCaseRefund && (!(amountNum > 0) || (item.amount ? amountNum > item.amount.value + 0.005 : false)));

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api(`/stores/${storeId}/returns/${item.kind}/${encodeURIComponent(item.ebayId)}/actions/${action}`, { body: { ...body, confirm: true } });
      toast.success(`${spec.title} - done`);
      globalMutate(`/stores/${storeId}/counts`);
      onDone();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      busy={busy}
      onClose={onClose}
      title={`${spec.title} · ${KIND_LABEL[item.kind]} ${item.ebayId}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={spec.variant} onClick={submit} loading={busy} disabled={invalid}>
            {spec.confirm}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {action === "refund" && !isCaseRefund && (
          <div>
            <label className="label" htmlFor="refund-amount">
              Refund amount ({currency})
            </label>
            <input id="refund-amount" className="input" type="number" step="0.01" min="0.01" max={item.amount?.value} value={amount} onChange={(e) => setAmount(e.target.value)} />
            {item.amount && (
              <div className="mt-1 flex gap-2 text-xs text-slate-500">
                Buyer paid up to {money(item.amount.value, currency)}.
                <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setAmount(item.amount!.value.toFixed(2))}>
                  Full refund
                </button>
              </div>
            )}
          </div>
        )}
        {isCaseRefund && item.amount && <p>Full refund of {money(item.amount.value, currency)} to close the case.</p>}
        {(action === "tracking" || action === "reject") && (
          <div className="grid gap-3 sm:grid-cols-2">
            {action === "tracking" && (
              <div>
                <label className="label" htmlFor="carrier">Carrier</label>
                <input id="carrier" className="input" placeholder="USPS, UPS, FedEx…" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
              </div>
            )}
            <div>
              <label className="label" htmlFor="tracking">Tracking number{action === "reject" ? " (optional)" : ""}</label>
              <input id="tracking" className="input" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="shipped">Shipped on (optional)</label>
              <input id="shipped" className="input" type="date" value={shippedDate} onChange={(e) => setShippedDate(e.target.value)} />
            </div>
          </div>
        )}
        {!(item.kind === "cancellation") && action !== "tracking" && (
          <div>
            <label className="label" htmlFor="note">
              {action === "message" ? "Message" : action === "decline" ? "Reason (sent to the buyer)" : "Note to the buyer (optional)"}
            </label>
            <textarea id="note" className="input min-h-[96px]" maxLength={action === "message" ? 2000 : 1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        <Alert kind={spec.variant === "danger" ? "warning" : "info"}>{spec.effect(item)}</Alert>
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}
