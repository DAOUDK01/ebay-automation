"use client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api, timeAgo } from "@/lib/api";
import type { SyncInfo } from "@/lib/finances";

/** "Synced 5m ago · 120 transactions" + a refresh button for one account module. */
export function SyncStatus({ storeId, module, sync, onQueued }: { storeId: string; module: string; sync: SyncInfo | null | undefined; onQueued?: () => void }) {
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true);
    try {
      const r = await api<{ duplicate: boolean }>(`/stores/${storeId}/account-sync?module=${module}`, { method: "POST" });
      toast[r.duplicate ? "info" : "success"](r.duplicate ? "A refresh is already queued" : "Refresh queued - new data appears in a minute or two");
      onQueued?.();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      {sync?.error ? (
        <span className="text-rose-600">Last refresh failed: {sync.error}</span>
      ) : sync?.lastSuccessAt ? (
        <span>
          Synced from eBay {timeAgo(sync.lastSuccessAt)}
          {sync.summary ? ` · ${sync.summary}` : ""}
        </span>
      ) : (
        <span>Not synced from eBay yet</span>
      )}
      <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
        {!busy && <RefreshCw className="h-3.5 w-3.5" />}
        Refresh
      </Button>
    </div>
  );
}
