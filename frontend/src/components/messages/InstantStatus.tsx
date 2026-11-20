"use client";
import { Zap, ZapOff } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { cx } from "@/components/ui";
import { toast } from "@/components/toast";
import { api, fetcher, timeAgo } from "@/lib/api";

export interface InstantState {
  enabled: boolean;
  enabledAt: string | null;
  error: string;
  url: string;
  lastNotificationAt: string | null;
  notifications: number;
  signaturesVerified: boolean;
}

/** "Instant on" pill: eBay pushes new buyer messages here the moment they arrive. */
export function InstantStatus({ storeId, onState }: { storeId: string; onState?: (s: InstantState) => void }) {
  const { data, mutate } = useSWR<InstantState>(`/stores/${storeId}/messages/notifications`, fetcher, {
    refreshInterval: 120_000,
    onSuccess: onState,
  });
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      await api(`/stores/${storeId}/messages/notifications/enable`, { method: "POST" });
      toast.success("Instant messages are on - new buyer messages now arrive within seconds");
      await mutate();
    } catch (e: any) {
      toast.error(e.message);
      await mutate();
    } finally {
      setBusy(false);
    }
  };

  if (data.enabled) {
    const title = [
      "eBay sends new buyer messages here as soon as they arrive.",
      data.lastNotificationAt ? `Last one ${timeAgo(data.lastNotificationAt)} (${data.notifications} so far).` : "No new messages pushed yet.",
      data.signaturesVerified ? "" : "Tip: add EBAY_DEV_ID on the server to verify eBay's signature.",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <span title={title} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
        <Zap className="h-3.5 w-3.5 shrink-0" />
        Instant on
        {data.lastNotificationAt && <span className="hidden font-normal text-emerald-700 sm:inline">· last push {timeAgo(data.lastNotificationAt)}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={turnOn}
      disabled={busy}
      title={data.error ? `Couldn't turn on: ${data.error}` : "Get new buyer messages within seconds instead of at the next sync"}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-60",
        data.error ? "bg-amber-50 text-amber-800 hover:bg-amber-100" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
      )}
    >
      <ZapOff className="h-3.5 w-3.5 shrink-0" />
      {busy ? "Turning on…" : data.error ? "Instant off · retry" : "Turn on instant"}
    </button>
  );
}
