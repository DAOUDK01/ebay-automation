"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import useSWR from "swr";
import { AppShell } from "@/components/AppShell";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Card, Empty, Spinner } from "@/components/ui";
import { api, fetcher, money, timeAgo } from "@/lib/api";
import type { Store } from "@/lib/types";

function StoresInner() {
  const params = useSearchParams();
  const { data, isLoading, mutate } = useSWR<{ stores: Store[] }>("/stores", fetcher, { refreshInterval: 15000 });
  const [connecting, setConnecting] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasting, setPasting] = useState(false);
  const ebayError = params.get("ebayError");

  async function connect() {
    setConnecting(true);
    try {
      const { url } = await api<{ url: string }>("/ebay/connect-url");
      window.location.href = url;
    } catch (e: any) {
      toast.error(e.message);
      setConnecting(false);
    }
  }

  async function submitPasted() {
    setPasting(true);
    try {
      const { store } = await api<{ store: { id: string; name: string } }>("/ebay/exchange", { body: { redirectUrl: pasted } });
      toast.success(`Connected ${store.name}`);
      setPasted("");
      setShowPaste(false);
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setPasting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Your eBay stores</h1>
          <p className="text-sm text-slate-500">Connect a seller account, then let the optimizer work through your listings in batches.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowPaste((v) => !v)}>
            Paste eBay code
          </Button>
          <Button onClick={connect} loading={connecting}>
            Connect eBay account
          </Button>
        </div>
      </div>

      {ebayError && <Alert>eBay connection failed: {ebayError}</Alert>}

      {showPaste && (
        <Card title="Manual connection">
          <p className="mb-3 text-sm text-slate-600">
            If eBay redirected you to a page that didn&apos;t load (common on localhost), copy the full address from the browser
            bar - it contains <code className="rounded bg-slate-100 px-1">?code=...</code> - and paste it here.
          </p>
          <div className="flex gap-2">
            <input className="input" placeholder="https://...?code=v%5E1.1%23i..." value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <Button onClick={submitPasted} loading={pasting} disabled={!pasted}>
              Connect
            </Button>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="flex justify-center py-20 text-slate-400">
          <Spinner />
        </div>
      ) : !data?.stores.length ? (
        <Empty title="No eBay accounts connected yet">Click “Connect eBay account” and sign in to eBay to grant access.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.stores.map((s) => (
            <Link
              key={s.id}
              href={`/stores/${s.id}`}
              className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500 hover:shadow"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold group-hover:text-brand-700">{s.name}</div>
                  <div className="text-xs text-slate-500">
                    {s.ebayUserId} · {s.marketplaceId}
                  </div>
                </div>
                {s.runner.enabled ? <Badge color="green">running</Badge> : <Badge>paused</Badge>}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-lg font-semibold">{s.stats?.activeListings ?? 0}</div>
                  <div className="text-xs text-slate-500">listings</div>
                </div>
                <div>
                  <div className="text-lg font-semibold">{s.stats?.processedListings ?? 0}</div>
                  <div className="text-xs text-slate-500">optimized</div>
                </div>
                <div>
                  <div className="text-lg font-semibold">{s.stats?.pendingReview ?? 0}</div>
                  <div className="text-xs text-slate-500">to review</div>
                </div>
              </div>
              <div className="mt-4 flex justify-between text-xs text-slate-500">
                <span>Mode: {s.settings.mode}</span>
                <span>
                  {money(s.stats?.monthSpendUsd)} / {money(s.settings.claude.monthlyBudgetUsd)} this month
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-400">Last sync {timeAgo(s.lastSyncAt)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StoresPage() {
  return (
    <AppShell>
      <Suspense>
        <StoresInner />
      </Suspense>
    </AppShell>
  );
}
