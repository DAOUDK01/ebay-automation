"use client";
import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { Button, Card, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { FEEDBACK_MAX, type FeedbackSettings } from "@/lib/feedback";
import { LimitedText } from "./Modal";

/** Opt-in: leave positive feedback for every paid buyer during the background sync. Off by default. */
export function AutoFeedbackCard({ storeId, settings, onSaved }: { storeId: string; settings: FeedbackSettings; onSaved: () => void }) {
  const [text, setText] = useState(settings.autoText);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(settings.autoText), [settings.autoText]);

  async function save(body: Partial<FeedbackSettings>, msg: string) {
    setBusy(true);
    try {
      await api(`/stores/${storeId}/feedback/settings`, { method: "PUT", body });
      toast.success(msg);
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(on: boolean) {
    if (on && !confirm(`Turn on automatic feedback?\n\nEvery background sync will leave positive feedback for each paid buyer still waiting for it, using:\n"${text.trim()}"`)) return;
    save({ autoPositive: on }, on ? "Automatic feedback is on" : "Automatic feedback is off");
  }

  return (
    <Card title="Automatic feedback">
      <div className="space-y-3">
        <Toggle checked={settings.autoPositive} onChange={toggle} disabled={busy} label={<span className="font-medium text-slate-700">Leave positive feedback automatically after payment</span>} />
        <p className="text-xs text-slate-500">
          Off by default. When on, each background sync leaves feedback for up to 25 buyers (oldest sales first).
        </p>
        <div>
          <label className="label">Comment</label>
          <LimitedText value={text} onChange={setText} max={FEEDBACK_MAX} />
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" disabled={busy || !text.trim() || text.trim() === settings.autoText} onClick={() => save({ autoText: text.trim() }, "Comment saved")}>
            Save comment
          </Button>
        </div>
      </div>
    </Card>
  );
}
