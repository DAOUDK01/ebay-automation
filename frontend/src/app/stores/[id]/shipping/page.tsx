"use client";
import { ArrowRight, Printer, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import useSWR from "swr";
import { InlineTracking } from "@/components/orders/InlineTracking";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Card, cx, Empty, Spinner, Stat } from "@/components/ui";
import { api, fetcher, money, timeAgo } from "@/lib/api";
import { addressLines, itemsCount, shipByLabel, type PolicyFix, type QueueOrder } from "@/lib/orders";

function Queue({ storeId }: { storeId: string }) {
  const { data, mutate } = useSWR<{ items: QueueOrder[]; overdue: number; dueToday: number }>(`/stores/${storeId}/shipping/queue`, fetcher, {
    refreshInterval: 60_000,
  });
  if (!data)
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Spinner />
      </div>
    );
  const ids = data.items.map((o) => encodeURIComponent(o.orderId)).join(",");
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="To ship" value={data.items.length} />
        <Stat label="Overdue" value={<span className={data.overdue ? "text-rose-600" : ""}>{data.overdue}</span>} hint="Ship-by date has passed" />
        <Stat label="Due within 24h" value={data.dueToday} />
      </div>
      <Card
        title="Awaiting shipment"
        actions={
          data.items.length > 0 && (
            <Link href={`/stores/${storeId}/orders/print?ids=${ids}`} target="_blank">
              <Button size="sm" variant="secondary">
                <Printer className="h-3.5 w-3.5" /> Print all packing slips
              </Button>
            </Link>
          )
        }
      >
        {!data.items.length ? (
          <Empty title="All caught up">No paid orders are waiting to be shipped.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className="table-th">Ship by</th>
                  <th className="table-th">Order</th>
                  <th className="table-th">Ship to</th>
                  <th className="table-th">Service</th>
                  <th className="table-th">Tracking</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((o) => {
                  const sb = shipByLabel(o.shipByDate);
                  return (
                    <tr key={o.orderId} className={cx(o.overdue ? "bg-rose-50/70" : o.dueSoon ? "bg-amber-50/50" : "")}>
                      <td className="table-td whitespace-nowrap">
                        <span className={cx("text-sm", o.overdue ? "font-semibold text-rose-600" : o.dueSoon ? "font-medium text-amber-700" : "text-slate-600")}>
                          {sb.text}
                        </span>
                      </td>
                      <td className="table-td">
                        <Link href={`/stores/${storeId}/orders?tab=awaiting&order=${encodeURIComponent(o.orderId)}`} className="font-medium text-slate-900 hover:text-brand-700">
                          {o.orderId}
                        </Link>
                        <div className="max-w-xs truncate text-xs text-slate-500">
                          {itemsCount(o)}× {o.lineItems[0]?.title}
                          {o.lineItems.length > 1 && ` +${o.lineItems.length - 1} more`}
                        </div>
                      </td>
                      <td className="table-td text-xs text-slate-600">
                        <div className="font-medium text-slate-800">{o.shipTo.name || o.buyer.username}</div>
                        {addressLines(o.shipTo).slice(1, 4).join(", ")}
                      </td>
                      <td className="table-td text-xs text-slate-600">
                        {o.shippingService || "—"}
                        <div>{money(o.totals.shipping, o.totals.currency)} paid</div>
                      </td>
                      <td className="table-td">
                        <InlineTracking storeId={storeId} order={o} onDone={() => mutate()} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

type ApplyState = Record<string, "pending" | "done" | string>;

function PolicyFixes({ storeId }: { storeId: string }) {
  const [live, setLive] = useState(false);
  const { data, mutate, isValidating } = useSWR<{ items: PolicyFix[]; live: boolean; liveError: string }>(
    `/stores/${storeId}/shipping/policy-fixes${live ? "?live=1" : ""}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [state, setState] = useState<ApplyState>({});
  const [running, setRunning] = useState(false);

  if (!data)
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Spinner />
      </div>
    );
  const items = data.items;
  const allChecked = items.length > 0 && items.every((f) => selected.includes(f.itemId));

  async function applySelected() {
    const rows = items.filter((f) => selected.includes(f.itemId));
    if (!rows.length) return;
    if (!confirm(`Change the shipping policy on ${rows.length} listing${rows.length === 1 ? "" : "s"} on eBay now? Each change is saved in Change history and can be reverted.`)) return;
    setRunning(true);
    let ok = 0;
    for (const f of rows) {
      setState((s) => ({ ...s, [f.itemId]: "pending" }));
      try {
        await api(`/stores/${storeId}/shipping/policy-fixes/${f.itemId}/apply`, { body: { policyId: f.suggested.id } });
        ok++;
        setState((s) => ({ ...s, [f.itemId]: "done" }));
      } catch (e: any) {
        setState((s) => ({ ...s, [f.itemId]: e.message }));
      }
    }
    setRunning(false);
    setSelected([]);
    toast[ok === rows.length ? "success" : "error"](`${ok} of ${rows.length} listings updated`);
    mutate();
  }

  return (
    <Card
      title="Listings on the wrong shipping policy"
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => (live ? mutate() : setLive(true))} loading={isValidating} title="Re-run the check against your current eBay shipping policies">
            {!isValidating && <RefreshCw className="h-3.5 w-3.5" />} Re-check with eBay policies
          </Button>
          <Button size="sm" onClick={applySelected} loading={running} disabled={!selected.length}>
            Apply selected ({selected.length})
          </Button>
        </>
      }
    >
      {data.liveError && (
        <div className="mb-4">
          <Alert kind="warning">{data.liveError}</Alert>
        </div>
      )}
      {!items.length ? (
        <Empty title="No policy fixes">
          Every analysed listing is on the suggested shipping policy. Listings are analysed when the optimizer processes them (Shipping weight
          module).
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-200">
              <tr>
                <th className="table-th w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allChecked}
                    onChange={() => setSelected(allChecked ? [] : items.map((f) => f.itemId))}
                  />
                </th>
                <th className="table-th">Listing</th>
                <th className="table-th">Policy change</th>
                <th className="table-th">Why</th>
                <th className="table-th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((f) => {
                const st = state[f.itemId];
                return (
                  <tr key={f.itemId} className="hover:bg-slate-50">
                    <td className="table-td">
                      <input
                        type="checkbox"
                        aria-label={`Select ${f.itemId}`}
                        disabled={running}
                        checked={selected.includes(f.itemId)}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, f.itemId] : selected.filter((x) => x !== f.itemId))}
                      />
                    </td>
                    <td className="table-td">
                      <div className="flex items-center gap-2">
                        {f.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={f.imageUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="h-9 w-9 shrink-0 rounded bg-slate-100" />
                        )}
                        <div className="min-w-0">
                          <Link href={`/stores/${storeId}/listings/${f.itemId}`} className="block max-w-xs truncate text-sm font-medium text-slate-800 hover:text-brand-700">
                            {f.title}
                          </Link>
                          <div className="text-xs text-slate-500">
                            {f.itemId} · analysed {timeAgo(f.analysedAt)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="table-td whitespace-nowrap text-sm">
                      <span className="text-slate-500">{f.current?.name || "none"}</span>
                      <ArrowRight className="mx-1.5 inline h-3.5 w-3.5 text-slate-400" />
                      <span className="font-medium text-slate-900">{f.suggested.name}</span>
                    </td>
                    <td className="table-td max-w-sm text-xs text-slate-600">
                      {f.note}
                      <div className="text-slate-400">
                        billable {f.billableKg} kg{f.source === "estimate" ? " (estimated)" : ""}
                        {f.pendingInBatch && " · also waiting in a review batch"}
                      </div>
                    </td>
                    <td className="table-td whitespace-nowrap text-right">
                      {st === "pending" ? (
                        <Spinner className="h-4 w-4 text-slate-400" />
                      ) : st === "done" ? (
                        <Badge color="green">changed</Badge>
                      ) : st ? (
                        <span className="text-xs text-rose-600" title={st}>
                          failed
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.values(state).some((s) => s !== "pending" && s !== "done") && (
            <div className="mt-3">
              <Alert>
                {Object.entries(state)
                  .filter(([, s]) => s !== "pending" && s !== "done")
                  .map(([k, s]) => (
                    <div key={k}>
                      {k}: {s}
                    </div>
                  ))}
              </Alert>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ShippingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab") === "policies" ? "policies" : "queue";
  return (
    <div className="space-y-4">
      <div className="flex border-b border-slate-200">
        {[
          ["queue", "Awaiting shipment"],
          ["policies", "Policy fixes"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => router.replace(`${pathname}${k === "queue" ? "" : "?tab=policies"}`, { scroll: false })}
            className={cx(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition",
              tab === k ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "queue" ? <Queue storeId={id} /> : <PolicyFixes storeId={id} />}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ShippingPage />
    </Suspense>
  );
}
