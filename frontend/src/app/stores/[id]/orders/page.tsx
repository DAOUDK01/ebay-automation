"use client";
import { Printer, Upload } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import useSWR from "swr";
import { OrderDrawer, OrderStatusBadge } from "@/components/orders/OrderDrawer";
import { BulkTrackingDialog } from "@/components/orders/BulkTrackingDialog";
import { TrackingDialog } from "@/components/orders/TrackingDialog";
import { Button, Card, cx, Empty, Pagination, Spinner } from "@/components/ui";
import { fetcher, money, timeAgo } from "@/lib/api";
import { itemsCount, ORDER_TABS, shipByLabel, type Order, type OrderFilter, type OrderList } from "@/lib/orders";

function OrdersPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (params.get("tab") as OrderFilter) || "awaiting";
  const openId = params.get("order");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [tracking, setTracking] = useState<Order | null>(null);
  const key = `/stores/${id}/orders?status=${tab}&page=${page}&q=${encodeURIComponent(search)}${tab === "awaiting" ? "&sort=shipBy" : ""}`;
  const { data, mutate } = useSWR<OrderList>(key, fetcher, { refreshInterval: 60_000 });

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const allOnPage = data?.items.map((o) => o.orderId) ?? [];
  const allChecked = allOnPage.length > 0 && allOnPage.every((x) => selected.includes(x));

  return (
    <div className="space-y-4">
      <Card
        title="Orders"
        actions={
          <>
            {selected.length > 0 && (
              <Link href={`/stores/${id}/orders/print?ids=${selected.map(encodeURIComponent).join(",")}`} target="_blank">
                <Button size="sm" variant="secondary">
                  <Printer className="h-3.5 w-3.5" /> Packing slips ({selected.length})
                </Button>
              </Link>
            )}
            <Button size="sm" variant="secondary" onClick={() => setBulk(true)}>
              <Upload className="h-3.5 w-3.5" /> Tracking from CSV
            </Button>
          </>
        }
      >
        <div className="-mx-5 -mt-5 mb-4 flex overflow-x-auto border-b border-slate-100 px-3">
          {ORDER_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => (setParam("tab", t.key), setPage(1), setSelected([]))}
              className={cx(
                "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition",
                tab === t.key ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              {t.label}
              {data?.tabs && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{data.tabs[t.key]}</span>}
            </button>
          ))}
        </div>

        <form
          className="mb-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(q);
          }}
        >
          <input className="input max-w-sm" placeholder="Order #, buyer, item, SKU or tracking" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        {!data ? (
          <div className="flex justify-center py-16 text-slate-400">
            <Spinner />
          </div>
        ) : !data.total ? (
          <Empty title={search ? "No orders match" : tab === "awaiting" ? "Nothing to ship" : "No orders here"}>
            {data.tabs.all ? "Try another tab or search." : "Orders appear after the next account sync (every 15 minutes, or “Sync now” on the Dashboard)."}
          </Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200">
                  <tr>
                    <th className="table-th w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allChecked}
                        onChange={() => setSelected(allChecked ? selected.filter((x) => !allOnPage.includes(x)) : [...new Set([...selected, ...allOnPage])])}
                      />
                    </th>
                    <th className="table-th">Order</th>
                    <th className="table-th">Items</th>
                    <th className="table-th">Buyer</th>
                    <th className="table-th">Total</th>
                    <th className="table-th">Ship by</th>
                    <th className="table-th">Status</th>
                    <th className="table-th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((o) => {
                    const sb = shipByLabel(o.shipByDate);
                    const first = o.lineItems[0];
                    return (
                      <tr key={o.orderId} className="cursor-pointer hover:bg-slate-50" onClick={() => setParam("order", o.orderId)}>
                        <td className="table-td" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${o.orderId}`}
                            checked={selected.includes(o.orderId)}
                            onChange={(e) => setSelected(e.target.checked ? [...selected, o.orderId] : selected.filter((x) => x !== o.orderId))}
                          />
                        </td>
                        <td className="table-td">
                          <div className="whitespace-nowrap font-medium text-slate-900">{o.orderId}</div>
                          <div className="text-xs text-slate-500">{timeAgo(o.creationDate)}</div>
                        </td>
                        <td className="table-td">
                          <div className="flex items-center gap-2">
                            {first?.image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={first.image} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                            ) : (
                              <div className="h-9 w-9 shrink-0 rounded bg-slate-100" />
                            )}
                            <div className="min-w-0">
                              <div className="max-w-[16rem] truncate text-sm text-slate-800">{first?.title}</div>
                              <div className="text-xs text-slate-500">
                                {itemsCount(o)} item{itemsCount(o) === 1 ? "" : "s"}
                                {o.lineItems.length > 1 && ` · ${o.lineItems.length} listings`}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="table-td">
                          <div className="text-sm">{o.buyer.username}</div>
                          <div className="text-xs text-slate-500">
                            {[o.shipTo.city, o.shipTo.state].filter(Boolean).join(", ")}
                          </div>
                        </td>
                        <td className="table-td font-medium">{money(o.totals.total, o.totals.currency)}</td>
                        <td className="table-td whitespace-nowrap">
                          {o.status === "awaiting_shipment" ? (
                            <span className={cx("text-sm", sb.overdue ? "font-semibold text-rose-600" : sb.soon ? "font-medium text-amber-700" : "text-slate-600")}>{sb.text}</span>
                          ) : o.fulfillments[0] ? (
                            <span className="text-xs text-slate-500">
                              {o.fulfillments[0].carrier} <span className="font-mono">{o.fulfillments[0].trackingNumber}</span>
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="table-td whitespace-nowrap">
                          <OrderStatusBadge order={o} />
                        </td>
                        <td className="table-td text-right" onClick={(e) => e.stopPropagation()}>
                          {o.status === "awaiting_shipment" && (
                            <Button size="sm" variant="secondary" onClick={() => setTracking(o)}>
                              Add tracking
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      {openId && <OrderDrawer storeId={id} orderId={openId} onClose={() => setParam("order", null)} onChanged={() => mutate()} />}
      {bulk && <BulkTrackingDialog storeId={id} onClose={() => setBulk(false)} onDone={() => mutate()} />}
      {tracking && (
        <TrackingDialog
          storeId={id}
          order={tracking}
          onClose={() => setTracking(null)}
          onDone={() => {
            setTracking(null);
            mutate();
          }}
        />
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <OrdersPage />
    </Suspense>
  );
}
