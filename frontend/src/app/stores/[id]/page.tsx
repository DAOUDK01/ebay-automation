"use client";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  CopyX,
  MessageSquare,
  RefreshCw,
  ShoppingCart,
  Star,
  Truck,
  Undo2,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import useSWR from "swr";
import { LineChart } from "@/components/analytics/LineChart";
import { Kpi } from "@/components/analytics/Panels";
import { useStore } from "@/components/StoreContext";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Card, StatusBadge, Toggle, cx } from "@/components/ui";
import { api, dateTime, fetcher, money, timeAgo } from "@/lib/api";
import type { SalesReport } from "@/lib/analytics";
import type { FinancesSummary } from "@/lib/finances";
import type { ThreadsResponse } from "@/lib/messages";
import type { OrderList } from "@/lib/orders";
import type { Counts, ModuleSyncStatus } from "@/lib/types";

/** Silent SWR: a module that isn't available just leaves its widget empty. */
const quiet = { revalidateOnFocus: false, shouldRetryOnError: false } as const;

function Attention({
  href,
  icon: Icon,
  label,
  count,
  detail,
  tone = "amber",
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  count: number;
  detail: string;
  tone?: "amber" | "rose" | "brand";
}) {
  const colors = { amber: "bg-amber-50 text-amber-700", rose: "bg-rose-50 text-rose-700", brand: "bg-brand-50 text-brand-700" }[tone];
  return (
    <Link href={href} className="group flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-400 hover:shadow">
      <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", colors)}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold text-slate-900">{count.toLocaleString()}</span>
          <span className="truncate text-sm font-medium text-slate-700">{label}</span>
        </div>
        <div className="truncate text-xs text-slate-500">{detail}</div>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-brand-600" />
    </Link>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Dashboard() {
  const { data, mutate } = useStore();
  const params = useSearchParams();
  const { store, jobs, batches, usage } = data;
  const id = store.id;
  const st = store.stats!;
  const s = store.settings;
  const [busy, setBusy] = useState("");
  const [limit, setLimit] = useState(5);
  const [showJobs, setShowJobs] = useState(false);

  const counts = useSWR<{ counts: Counts }>(`/stores/${id}/counts`, fetcher, { refreshInterval: 60_000 });
  const sales = useSWR<SalesReport>(`/stores/${id}/analytics/sales?days=30`, fetcher, quiet);
  const funds = useSWR<FinancesSummary>(`/stores/${id}/finances/summary`, fetcher, quiet);
  const toShip = useSWR<OrderList>(`/stores/${id}/orders?status=awaiting&sort=shipBy&pageSize=5`, fetcher, quiet);
  const unread = useSWR<ThreadsResponse>(`/stores/${id}/messages/threads?unread=1&pageSize=5`, fetcher, quiet);
  const dups = useSWR<{ totals: { groups: number; extraListings: number } }>(`/stores/${id}/inventory/duplicates`, fetcher, quiet);
  const sync = useSWR<{ modules: ModuleSyncStatus[] }>(`/stores/${id}/account-sync`, fetcher, { refreshInterval: 30_000 });

  const c = counts.data?.counts ?? {};
  const cur = c.currency ?? sales.data?.currency ?? "USD";
  const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued");
  const budgetPct = s.claude.monthlyBudgetUsd ? Math.min(100, (st.monthSpendUsd / s.claude.monthlyBudgetUsd) * 100) : 0;

  async function act(key: string, fn: () => Promise<any>, ok: string) {
    setBusy(key);
    try {
      const r = await fn();
      toast[r?.duplicate ? "info" : "success"](r?.duplicate ? "Already queued" : ok);
      mutate();
      sync.mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  }

  const attention = [
    c.awaitingShipment ? { href: `/stores/${id}/shipping`, icon: Truck, label: "orders to ship", count: c.awaitingShipment, detail: "Add tracking before the ship-by date", tone: "rose" as const } : null,
    c.openReturns || c.openCases
      ? { href: `/stores/${id}/returns`, icon: Undo2, label: "returns & cases", count: (c.openReturns ?? 0) + (c.openCases ?? 0), detail: "Respond before eBay's deadline", tone: "rose" as const }
      : null,
    c.unreadMessages ? { href: `/stores/${id}/messages`, icon: MessageSquare, label: "unread messages", count: c.unreadMessages, detail: "Buyers waiting for an answer" } : null,
    c.negativeFeedback ? { href: `/stores/${id}/feedback`, icon: Star, label: "feedback to answer", count: c.negativeFeedback, detail: "Neutral or negative, no reply yet" } : null,
    c.lowStock ? { href: `/stores/${id}/inventory`, icon: Boxes, label: "low on stock", count: c.lowStock, detail: "Active listings almost sold out" } : null,
    dups.data?.totals.extraListings
      ? { href: `/stores/${id}/duplicates`, icon: CopyX, label: "duplicate listings", count: dups.data.totals.extraListings, detail: `${dups.data.totals.groups} items listed more than once` }
      : null,
    st.pendingReview ? { href: `/stores/${id}/batches`, icon: WandSparkles, label: "suggestions to review", count: st.pendingReview, detail: "Optimizer changes waiting for approval", tone: "brand" as const } : null,
  ].filter(Boolean) as Parameters<typeof Attention>[0][];

  const syncing = (sync.data?.modules ?? []).filter((m) => m.syncs);
  const syncErrors = syncing.filter((m) => m.error);

  return (
    <div className="space-y-8">
      {params.get("connected") && (
        <Alert kind="success">
          eBay account connected. Click <b>Sync everything now</b> below to load orders, messages, returns and money, then sync your listings for the
          optimizer.
        </Alert>
      )}
      {store.runner.lastError && <Alert kind="warning">Last optimizer error: {store.runner.lastError}</Alert>}

      {/* ---------------- today */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Sales today" value={typeof c.salesToday === "number" ? money(c.salesToday, cur) : "—"} hint={typeof c.ordersToday === "number" ? `${c.ordersToday} orders` : "Orders not synced yet"} />
        <Kpi
          label="Revenue · 30 days"
          value={sales.data?.hasOrders ? money(sales.data.totals.revenue, cur) : "—"}
          delta={sales.data?.hasOrders ? sales.data.change.revenue : undefined}
          hint={sales.data?.hasOrders ? `${sales.data.totals.orders} orders · avg ${money(sales.data.totals.avgOrderValue, cur)}` : undefined}
        />
        <Kpi label="To ship" value={typeof c.awaitingShipment === "number" ? c.awaitingShipment : "—"} hint="Paid, not shipped" />
        <Kpi
          label="Available funds"
          value={funds.data?.funds ? money(funds.data.funds.availableFunds, funds.data.funds.currency) : "—"}
          hint={funds.data?.funds ? `${money(funds.data.funds.processingFunds, funds.data.funds.currency)} processing` : "Finances not synced yet"}
        />
        <Kpi
          label="Seller level"
          value={<span className="text-lg">{c.sellerLevel ? c.sellerLevel.replace(/_/g, " ").toLowerCase() : "—"}</span>}
          hint={<Link href={`/stores/${id}/analytics`} className="text-brand-600 hover:underline">Account health</Link>}
        />
      </div>

      {/* ---------------- needs attention */}
      <Section title="Needs your attention">
        {attention.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {attention.map((a) => (
              <Attention key={a.label} {...a} />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <CheckCircle2 className="h-5 w-5" /> All caught up - nothing waiting on you right now.
          </div>
        )}
      </Section>

      {/* ---------------- sales + money */}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          {sales.data?.hasOrders ? (
            <LineChart
              title="Revenue"
              total={money(sales.data.totals.revenue, cur)}
              periodLabel="in 30 days"
              colorClass="text-emerald-600"
              format={(n) => money(n, cur)}
              points={sales.data.days.map((d) => ({ day: d.day, value: d.revenue }))}
            />
          ) : (
            <Card title="Revenue">
              <p className="text-sm text-slate-500">Sales appear here once orders are synced.</p>
            </Card>
          )}
        </div>
        <Card title="Money" className="min-w-0" actions={<Link className="text-xs text-brand-600" href={`/stores/${id}/finances`}>Finances</Link>}>
          {funds.data?.funds ? (
            <dl className="space-y-2 text-sm">
              {(
                [
                  ["Available", funds.data.funds.availableFunds],
                  ["Processing", funds.data.funds.processingFunds],
                  ["On hold", funds.data.funds.fundsOnHold],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-medium tabular-nums">{money(v, funds.data!.funds!.currency)}</dd>
                </div>
              ))}
              {funds.data.lastPayout && (
                <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  Last payout {money(funds.data.lastPayout.amount, funds.data.lastPayout.currency)} · {timeAgo(funds.data.lastPayout.payoutDate)}
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">{funds.data?.needsDigitalSignature ? "Not available for EU/UK accounts yet." : "Funds appear after the first Finances sync."}</p>
          )}
        </Card>
      </div>

      {/* ---------------- ship next + messages */}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Ship next" className="min-w-0" actions={<Link className="text-xs text-brand-600" href={`/stores/${id}/shipping`}>Shipping queue</Link>}>
          {toShip.data?.items.length ? (
            <ul className="divide-y divide-slate-100">
              {toShip.data.items.map((o) => {
                const overdue = o.shipByDate && new Date(o.shipByDate) < new Date();
                return (
                  <li key={o.orderId} className="flex items-center gap-3 py-2 text-sm">
                    {o.lineItems[0]?.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.lineItems[0].image} alt="" className="h-9 w-9 shrink-0 rounded border border-slate-200 object-cover" />
                    ) : (
                      <ShoppingCart className="h-9 w-9 shrink-0 rounded bg-slate-100 p-2 text-slate-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-slate-800">{o.lineItems[0]?.title ?? o.orderId}</div>
                      <div className="text-xs text-slate-500">
                        {o.buyer.username} · {money(o.totals.total, o.totals.currency)}
                      </div>
                    </div>
                    <Badge color={overdue ? "red" : "yellow"}>{o.shipByDate ? `ship by ${new Date(o.shipByDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "to ship"}</Badge>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">{toShip.error ? "Orders aren't available for this account yet." : "Nothing waiting to ship."}</p>
          )}
        </Card>
        <Card title="Unread messages" className="min-w-0" actions={<Link className="text-xs text-brand-600" href={`/stores/${id}/messages`}>Inbox</Link>}>
          {unread.data?.items.length ? (
            <ul className="divide-y divide-slate-100">
              {unread.data.items.map((t) => (
                <li key={t.id} className="py-2 text-sm">
                  <Link href={`/stores/${id}/messages?thread=${t.id}`} className="block hover:bg-slate-50">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-slate-800">{t.buyer}</span>
                      <span className="shrink-0 text-xs text-slate-400">{timeAgo(t.lastAt)}</span>
                    </div>
                    <div className="truncate text-xs text-slate-500">{t.itemTitle || t.subject}</div>
                    <div className="line-clamp-1 text-slate-600">{t.preview}</div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">{unread.error ? "Messages aren't available yet." : "No unread messages."}</p>
          )}
        </Card>
      </div>

      {/* ---------------- listing optimizer */}
      <Section title="Listing optimizer" action={<Link className="text-xs text-brand-600" href={`/stores/${id}/batches`}>Review & batches</Link>}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label="Active listings" value={st.activeListings.toLocaleString()} hint={`listings synced ${timeAgo(store.lastSyncAt)}`} />
          <Kpi
            label="Optimized"
            value={st.processedListings.toLocaleString()}
            hint={st.activeListings ? `${Math.round((st.processedListings / st.activeListings) * 100)}% · ${st.neverProcessed} never touched` : ""}
          />
          <Kpi label="Waiting for review" value={st.pendingReview} hint={`${st.pushedTotal} changes pushed in total`} />
          <Kpi
            label="Claude this month"
            value={money(st.monthSpendUsd)}
            hint={
              <div>
                <div className="mt-1 h-1.5 w-full rounded bg-slate-100">
                  <div className={cx("h-1.5 rounded", budgetPct > 90 ? "bg-rose-500" : "bg-brand-500")} style={{ width: `${budgetPct}%` }} />
                </div>
                <div className="mt-1">of {money(s.claude.monthlyBudgetUsd)} budget</div>
              </div>
            }
          />
        </div>
        <Card>
          <div className="flex flex-wrap items-end gap-4">
            <Toggle
              checked={store.runner.enabled}
              disabled={busy === "runner"}
              onChange={(v) => act("runner", () => api(`/stores/${id}/runner`, { body: { enabled: v } }), v ? "Runner started" : "Runner paused")}
              label={
                <span>
                  <b>Automatic runner {store.runner.enabled ? "on" : "paused"}</b>
                  <span className="block text-xs text-slate-500">
                    {store.runner.enabled ? `next batch ${timeAgo(store.runner.nextRunAt)}` : "Batches run only when you start them"} · {s.batchSize} listings every{" "}
                    {s.gapBetweenBatchesMin} min · {s.mode} mode
                  </span>
                </span>
              }
            />
            <div className="ml-auto flex flex-wrap items-end gap-2">
              <Button variant="secondary" loading={busy === "sync"} onClick={() => act("sync", () => api(`/stores/${id}/sync`, { method: "POST" }), "Listing sync queued")}>
                Sync listings
              </Button>
              <input type="number" min={1} max={200} className="input w-20" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Listings in batch" />
              <Button loading={busy === "run"} onClick={() => act("run", () => api(`/stores/${id}/run`, { body: { limit } }), "Batch queued")}>
                Optimize {limit} now
              </Button>
            </div>
          </div>
          {activeJob && (
            <div className="mt-4 flex items-center justify-between rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">
              <span>
                <StatusBadge status={activeJob.status} /> {activeJob.type.replace("_", " ")} job{" "}
                {activeJob.status === "running" ? `started ${timeAgo(activeJob.startedAt)}` : "waiting for the worker"}
              </span>
              <button className="text-xs underline" onClick={() => act("cancel", () => api(`/stores/${id}/jobs/${activeJob._id}/cancel`, { method: "POST" }), "Cancelled")}>
                cancel
              </button>
            </div>
          )}
          {!!batches.length && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Recent batches</div>
              <ul className="divide-y divide-slate-100 text-sm">
                {batches.slice(0, 3).map((b) => (
                  <li key={b._id} className="flex flex-wrap items-center gap-3 py-1.5">
                    <Link className="font-medium text-brand-700" href={`/stores/${id}/batches/${b._id}`}>
                      #{b.number}
                    </Link>
                    <StatusBadge status={b.status} />
                    <span className="text-slate-600">
                      {b.counts.processed}/{b.counts.total} done · {b.counts.proposed} to review · {b.counts.pushed} pushed
                    </span>
                    <span className="ml-auto text-slate-400">{timeAgo(b.startedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </Section>

      {/* ---------------- sync + jobs */}
      <Section
        title="Account sync"
        action={
          <Button size="sm" variant="secondary" loading={busy === "acct"} onClick={() => act("acct", () => api(`/stores/${id}/account-sync`, { body: {} }), "Sync queued")}>
            <RefreshCw className="h-3.5 w-3.5" /> Sync everything now
          </Button>
        }
      >
        {syncErrors.length > 0 && (
          <Alert kind="warning">
            {syncErrors.map((m) => (
              <div key={m.key}>
                <b>{m.label}:</b> {m.error}
              </div>
            ))}
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          {syncing.map((m) => (
            <span key={m.key} className={cx("rounded-full border px-3 py-1 text-xs", m.error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-white text-slate-600")}>
              {m.label} · {m.lastSuccessAt ? timeAgo(m.lastSuccessAt) : "not synced"}
            </span>
          ))}
        </div>
        <button className="text-xs font-medium text-brand-600" onClick={() => setShowJobs((v) => !v)}>
          {showJobs ? "Hide worker jobs" : "Show worker jobs"}
        </button>
        {showJobs && (
          <Card>
            {!jobs.length ? (
              <p className="text-sm text-slate-500">No jobs yet.</p>
            ) : (
              <table className="w-full">
                <tbody className="divide-y divide-slate-100">
                  {jobs.map((j) => (
                    <tr key={j._id}>
                      <td className="table-td font-medium">{j.type.replace("_", " ")}</td>
                      <td className="table-td">
                        <StatusBadge status={j.status} />
                      </td>
                      <td className="table-td max-w-xs truncate text-xs text-rose-600" title={j.error}>
                        {j.error}
                      </td>
                      <td className="table-td text-right text-slate-500">{dateTime(j.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!!usage.length && (
              <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                Claude spend by month:{" "}
                {usage.map((u) => (
                  <span key={u.month} className="mr-3">
                    {u.month}: {money(u.usd)}
                  </span>
                ))}
              </div>
            )}
          </Card>
        )}
      </Section>
    </div>
  );
}

export default function StoreDashboardPage() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}
