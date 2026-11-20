"use client";
import { Send, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "@/components/returns/Modal";
import { toast } from "@/components/toast";
import { Alert, Button } from "@/components/ui";
import { api, money } from "@/lib/api";
import { fillTemplate, MAX_MESSAGE, type ThreadDetailResponse } from "@/lib/messages";
import { TemplatesPicker } from "./TemplatesPicker";

/**
 * Reply editor: write, use a template or "Draft with Claude" (fills the box, never sends).
 * Sending always goes through a confirm dialog.
 */
export function ReplyBox({ storeId, thread, onSent }: { storeId: string; thread: ThreadDetailResponse["thread"]; onSent: () => void }) {
  const draftKey = `reply-draft:${storeId}:${thread.id}`;
  const [text, setText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // keep an unsent draft per thread in this browser
  useEffect(() => {
    try {
      setText(localStorage.getItem(draftKey) ?? "");
    } catch {
      setText("");
    }
    setError("");
  }, [draftKey]);
  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage blocked */
    }
  }, [draftKey, text]);

  async function draft() {
    if (text.trim() && !confirm("Replace what you've written with Claude's draft?")) return;
    setDrafting(true);
    setError("");
    try {
      const r = await api<{ text: string; costUsd: number }>(`/stores/${storeId}/messages/threads/${thread.id}/draft`, { body: { instructions: instructions || undefined } });
      setText(r.text);
      toast.info(`Draft ready - check it before sending (${money(r.costUsd)})`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDrafting(false);
    }
  }

  async function send() {
    setSending(true);
    setError("");
    try {
      await api(`/stores/${storeId}/messages/threads/${thread.id}/reply`, { body: { body: text.trim(), confirm: true } });
      toast.success(`Sent to ${thread.buyer}`);
      setText("");
      setConfirming(false);
      onSent();
    } catch (e: any) {
      setError(e.message);
      setConfirming(false);
    } finally {
      setSending(false);
    }
  }

  const tooLong = text.length > MAX_MESSAGE;
  return (
    <div className="space-y-2">
      <textarea
        className="input min-h-[140px]"
        placeholder={`Reply to ${thread.buyer}…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Reply"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={draft} loading={drafting}>
          {!drafting && <Sparkles className="h-3.5 w-3.5 text-brand-600" />} Draft with Claude
        </Button>
        <input
          className="input w-full flex-1 py-1.5 text-xs sm:w-auto"
          placeholder="Optional hint for Claude, e.g. ask for their VIN"
          value={instructions}
          maxLength={500}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <TemplatesPicker
          storeId={storeId}
          currentText={text}
          onPick={(body) => setText(fillTemplate(body, { buyer: thread.buyer, item: thread.itemTitle || thread.itemId }))}
        />
        <span className={`ml-auto text-xs ${tooLong ? "font-semibold text-rose-600" : "text-slate-400"}`}>
          {text.length}/{MAX_MESSAGE}
        </span>
        <Button size="sm" onClick={() => setConfirming(true)} disabled={!text.trim() || tooLong}>
          <Send className="h-3.5 w-3.5" /> Send
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      <Modal
        open={confirming}
        busy={sending}
        onClose={() => setConfirming(false)}
        title={`Send to ${thread.buyer}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={sending}>
              Keep editing
            </Button>
            <Button onClick={send} loading={sending}>
              Send on eBay
            </Button>
          </>
        }
      >
        <p className="mb-2 text-xs text-slate-500">
          {thread.reply === "rtq" ? "Sent as the answer to their question" : "Sent as an eBay message about this order"}
          {thread.itemId ? ` (item ${thread.itemId})` : ""}.
        </p>
        <div className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">{text.trim()}</div>
      </Modal>
    </div>
  );
}
