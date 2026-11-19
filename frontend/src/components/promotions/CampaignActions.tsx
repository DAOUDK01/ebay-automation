"use client";
import { Pause, Play, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import type { Campaign } from "@/lib/promotions";
import { ConfirmDialog } from "./ConfirmDialog";

type Action = "pause" | "resume" | "end";

const COPY: Record<Action, { label: string; title: string; body: string; done: string }> = {
  pause: { label: "Pause", title: "Pause this campaign?", body: "Its ads stop showing until you resume it. Nothing is deleted.", done: "Campaign paused" },
  resume: { label: "Resume", title: "Resume this campaign?", body: "Its ads start showing again and ad fees apply to sales they bring in.", done: "Campaign resumed" },
  end: {
    label: "End",
    title: "End this campaign?",
    body: "Ending is permanent: eBay stops all its ads and the campaign can't be restarted. You'd have to create a new one.",
    done: "Campaign ended",
  },
};

/** Pause / resume / end - each behind a confirm dialog. */
export function CampaignActions({ storeId, campaign, onDone, size = "sm" }: { storeId: string; campaign: Campaign; onDone: () => void; size?: "sm" | "md" }) {
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const s = campaign.status;
  const can: Record<Action, boolean> = {
    pause: s === "RUNNING" || s === "SCHEDULED",
    resume: s === "PAUSED",
    end: s !== "ENDED" && s !== "DELETED",
  };

  async function run() {
    if (!pending) return;
    setBusy(true);
    try {
      await api(`/stores/${storeId}/promotions/campaigns/${campaign.campaignId}/${pending}`, { body: { confirm: true } });
      toast.success(COPY[pending].done);
      setPending(null);
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!can.pause && !can.resume && !can.end) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {can.pause && (
        <Button size={size} variant="secondary" onClick={() => setPending("pause")}>
          <Pause className="h-3.5 w-3.5" /> Pause
        </Button>
      )}
      {can.resume && (
        <Button size={size} variant="secondary" onClick={() => setPending("resume")}>
          <Play className="h-3.5 w-3.5" /> Resume
        </Button>
      )}
      {can.end && (
        <Button size={size} variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setPending("end")}>
          <Square className="h-3.5 w-3.5" /> End
        </Button>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={pending ? COPY[pending].title : ""}
        confirmLabel={pending ? `${COPY[pending].label} campaign` : ""}
        danger={pending === "end"}
        busy={busy}
        onConfirm={run}
        onCancel={() => setPending(null)}
      >
        <p>
          <b>{campaign.name}</b> ({campaign.adCount} listing{campaign.adCount === 1 ? "" : "s"})
        </p>
        <p>{pending ? COPY[pending].body : ""}</p>
      </ConfirmDialog>
    </div>
  );
}
