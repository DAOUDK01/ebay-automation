"use client";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";
import { FEEDBACK_MAX, ratingColor, type FeedbackEntry } from "@/lib/feedback";
import { LimitedText, Modal } from "./Modal";

/** Public reply to feedback a buyer left. eBay allows one reply and it can't be edited, so we confirm first. */
export function ReplyDialog({ storeId, fb, onClose, onDone }: { storeId: string; fb: FeedbackEntry; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    if (!confirm(`Post this reply publicly on eBay under ${fb.user || "the buyer"}'s feedback?\n\n"${text.trim()}"\n\nReplies can't be edited or removed.`)) return;
    setBusy(true);
    try {
      await api(`/stores/${storeId}/feedback/${fb._id}/reply`, { body: { text: text.trim() } });
      toast.success("Reply posted on eBay");
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Reply publicly"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={send} loading={busy} disabled={!text.trim()}>
            Post reply
          </Button>
        </>
      }
    >
      <div className="rounded-lg bg-slate-50 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Badge color={ratingColor(fb.rating)}>{fb.rating}</Badge>
          <span className="font-medium text-slate-700">{fb.user}</span>
        </div>
        <p className="text-slate-700">“{fb.comment}”</p>
        <p className="mt-1 text-xs text-slate-500">{fb.itemTitle}</p>
      </div>
      <p className="text-slate-600">Everyone who views your feedback will see this reply. Keep it calm and factual.</p>
      <LimitedText value={text} onChange={setText} max={FEEDBACK_MAX} placeholder="e.g. Sorry for the trouble - we sent a full refund." />
    </Modal>
  );
}
