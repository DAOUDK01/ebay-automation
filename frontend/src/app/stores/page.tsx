"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Store as StoreIcon } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import useSWR from "swr";
import { AppShell } from "@/components/AppShell";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Card, Empty, Spinner } from "@/components/ui";
import { api, fetcher, money, timeAgo } from "@/lib/api";
import type { Counts, Store } from "@/lib/types";

/** Business numbers shown for each account and in total ("—" until that module is built / synced). */
const KPIS: { key: keyof Counts; label: string; money?: boolean; alert?: boolean }[] = [
  { key: "salesToday", label: "sales today", money: true },
  { key: "awaitingShipment", label: "to ship", alert: true },
  { key: "unreadMessages", label: "unread", alert: true },
  { key: "openReturns", label: "returns", alert: true },
  { key: "availableFunds", label: "funds", money: true },
];

function kpiValue(c: Counts | undefined, k: (typeof KPIS)[number]) {
  const v = c?.[k.key];
  if (typeof v !== "number") return "—";
  return k.money ? money(v, c?.currency) : String(v);
}

function totals(stores: Store[]): Counts {
  const t: Counts = {};
  for (const k of KPIS) {
    const vals = stores.map((s) => s.counts?.[k.key]).filter((v): v is number => typeof v === "number");
    (t as any)[k.key] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  t.currency = stores.find((s) => s.counts?.currency)?.counts?.currency;
  return t;
}

function StoresInner() {
  const params = useSearchParams();
  const { data, isLoading, mutate } = useSWR<{ stores: Store[] }>("/stores", fetcher, { refreshInterval: 15000 });
  const [connecting, setConnecting] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasting, setPasting] = useState(false);
  const ebayError = params.get("ebayError");
  const wantsConnect = params.get("connect") === "1";

  // "Connect eBay store" in the sidebar links here with ?connect=1
  useEffect(() => {
    if (wantsConnect) connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsConnect]);

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
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <StoreIcon className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Your eBay stores</h1>
            <p className="text-sm text-slate-500">All your eBay accounts in one place. Pick one to manage its orders, listings, messages and money.</p>
          </div>
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
        <>
        {data.stores.length > 1 && (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-5">
            {KPIS.map((k) => (
              <div key={k.key}>
                <div className="text-xs uppercase tracking-wide text-slate-500">All accounts · {k.label}</div>
                <div className="text-xl font-semibold text-slate-900">{kpiValue(totals(data.stores), k)}</div>
              </div>
            ))}
          </div>
        )}
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
              <div className="mt-3 grid grid-cols-5 gap-1 rounded-lg bg-slate-50 p-2 text-center">
                {KPIS.map((k) => {
                  const v = s.counts?.[k.key];
                  const hot = k.alert && typeof v === "number" && v > 0;
                  return (
                    <div key={k.key}>
                      <div className={hot ? "text-sm font-semibold text-rose-600" : "text-sm font-semibold text-slate-800"}>{kpiValue(s.counts, k)}</div>
                      <div className="text-[10px] text-slate-500">{k.label}</div>
                    </div>
                  );
                })}
              </div>
              {!!s.missingFeatures?.length && (
                <div className="mt-2 text-xs text-amber-700">Reconnect needed for {s.missingFeatures.join(", ")}</div>
              )}
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
        </>
      )}
    </div>
  );
}

export default function StoresPage() {
  return (
    <AppShell header={<span className="text-sm font-medium text-slate-900">All stores</span>}>
      <Suspense>
        <StoresInner />
      </Suspense>
    </AppShell>
  );
}
