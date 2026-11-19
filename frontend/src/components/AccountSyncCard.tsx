"use client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { api, fetcher, timeAgo } from "@/lib/api";
import type { ModuleSyncStatus } from "@/lib/types";
import { toast } from "./toast";
import { Badge, Button, Card, Toggle } from "./ui";

/** Settings > Account sync: how often orders, messages, returns, finances... refresh from eBay, and their status. */
export function AccountSyncCard({
  storeId,
  value,
  onChange,
}: {
  storeId: string;
  value: { enabled: boolean; everyMin: number };
  onChange: (key: "enabled" | "everyMin", v: unknown) => void;
}) {
  const { data, mutate } = useSWR<{ lastScheduledAt: string | null; modules: ModuleSyncStatus[] }>(
    `/stores/${storeId}/account-sync`,
    fetcher,
    { refreshInterval: 10_000 },
  );
  const [busy, setBusy] = useState(false);
  const syncing = (data?.modules ?? []).filter((m) => m.syncs);

  async function syncNow() {
    setBusy(true);
    try {
      const r = await api<{ duplicate: boolean }>(`/stores/${storeId}/account-sync`, { body: {} });
      toast[r.duplicate ? "info" : "success"](r.duplicate ? "A refresh is already queued" : "Refresh queued");
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Account sync">
      <div className="space-y-4">
        <Toggle
          checked={value.enabled}
          onChange={(v) => onChange("enabled", v)}
          label={<b>Keep orders, messages, returns, feedback and finances up to date automatically</b>}
        />
        <div className="ml-11 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-600">Refresh every</span>
          <select className="input w-auto py-1" value={value.everyMin} disabled={!value.enabled} onChange={(e) => onChange("everyMin", Number(e.target.value))}>
            {[5, 10, 15, 30, 60, 120, 360].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" loading={busy} disabled={!syncing.length} onClick={syncNow}>
            <RefreshCw className="h-3.5 w-3.5" /> Sync now
          </Button>
        </div>

        <div className="ml-11 overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <tbody>
              {(data?.modules ?? []).map((m) => (
                <tr key={m.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-medium text-slate-700">{m.label}</td>
                  <td className="px-3 py-2">
                    {!m.ready ? (
                      <Badge>coming soon</Badge>
                    ) : m.error ? (
                      <span className="text-rose-600">{m.error}</span>
                    ) : m.lastSuccessAt ? (
                      <span className="text-slate-600">
                        {timeAgo(m.lastSuccessAt)}
                        {m.summary && <span className="text-slate-400"> · {m.summary}</span>}
                      </span>
                    ) : (
                      <span className="text-slate-400">not synced yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
