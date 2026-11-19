"use client";
import { ExternalLink, Printer, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Spinner } from "@/components/ui";
import { api, dateTime, fetcher, money } from "@/lib/api";
import { addressLines, ebayOrderUrl, refundedTotal, shipByLabel, STATUS_COLOR, STATUS_LABEL, type Order } from "@/lib/orders";
import { Drawer } from "./Modal";
import { RefundDialog } from "./RefundDialog";
import { TrackingDialog } from "./TrackingDialog";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

export function OrderStatusBadge({ order }: { order: Pick<Order, "status"> }) {
  return <Badge color={STATUS_COLOR[order.status]}>{STATUS_LABEL[order.status]}</Badge>;
}

/** Order details: buyer, address, items, totals, tracking, refunds + actions. */
export function OrderDrawer({ storeId, orderId, onClose, onChanged }: { storeId: string; orderId: string; onClose: () => void; onChanged: () => void }) {
  const key = `/stores/${storeId}/orders/${encodeURIComponent(orderId)}`;
  const { data, error, mutate } = useSWR<{ order: Order; refundable: number }>(key, fetcher);
  const [dialog, setDialog] = useState<"" | "tracking" | "refund">("");
  const [refreshing, setRefreshing] = useState(false);
  const o = data?.order;
  const cur = o?.totals.currency ?? "USD";

  const done = () => {
    setDialog("");
    mutate();
    onChanged();
  };

  async function refresh() {
    setRefreshing(true);
    try {
      await api(`${key}/refresh`, { method: "POST" });
      await mutate();
      onChanged();
      toast.success("Order refreshed from eBay");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Drawer
      title={
        <span className="flex items-center gap-2">
          Order {orderId} {o && <OrderStatusBadge order={o} />}
        </span>
      }
      onClose={onClose}
      actions={
        <Button size="sm" variant="ghost" onClick={refresh} loading={refreshing} title="Re-read this order from eBay">
          {!refreshing && <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      }
    >
      {error ? (
        <Alert>{error.message}</Alert>
      ) : !o ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            {o.status === "awaiting_shipment" && (
              <Button size="sm" onClick={() => setDialog("tracking")}>
                Add tracking
              </Button>
            )}
            {o.status === "shipped" && (
              <Button size="sm" variant="secondary" onClick={() => setDialog("tracking")}>
                Add another tracking number
              </Button>
            )}
            {data.refundable > 0 && o.paymentStatus !== "PENDING" && (
              <Button size="sm" variant="secondary" onClick={() => setDialog("refund")}>
                Refund
              </Button>
            )}
            <Link href={`/stores/${storeId}/orders/print?ids=${encodeURIComponent(o.orderId)}`} target="_blank">
              <Button size="sm" variant="secondary">
                <Printer className="h-3.5 w-3.5" /> Packing slip
              </Button>
            </Link>
            <a href={ebayOrderUrl(o.orderId)} target="_blank" rel="noreferrer">
              <Button size="sm" variant="ghost">
                <ExternalLink className="h-3.5 w-3.5" /> eBay
              </Button>
            </a>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-4 text-sm">
            <Section title="Buyer">
              <div className="font-medium text-slate-900">{o.buyer.username}</div>
              {o.buyer.name && <div className="text-slate-600">{o.buyer.name}</div>}
              {o.buyer.email && <div className="text-slate-500">{o.buyer.email}</div>}
            </Section>
            <Section title="Ship to">
              {addressLines(o.shipTo).map((l) => (
                <div key={l} className="text-slate-700">
                  {l}
                </div>
              ))}
              {o.shipTo.phone && <div className="text-slate-500">{o.shipTo.phone}</div>}
            </Section>
            <Section title="Ordered">
              <div className="text-slate-700">{dateTime(o.creationDate)}</div>
            </Section>
            <Section title="Ship by">
              <div className={shipByLabel(o.shipByDate).overdue && o.status === "awaiting_shipment" ? "font-medium text-rose-600" : "text-slate-700"}>
                {dateTime(o.shipByDate)}
              </div>
              <div className="text-slate-500">{o.shippingService || "—"}</div>
            </Section>
          </div>

          {o.buyerNotes && (
            <div className="mb-5">
              <Alert kind="warning">
                <b>Buyer note:</b> {o.buyerNotes}
              </Alert>
            </div>
          )}

          <Section title="Items">
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {o.lineItems.map((l) => (
                <li key={l.lineItemId} className="flex gap-3 p-3">
                  {l.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.image} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="h-12 w-12 shrink-0 rounded bg-slate-100" />
                  )}
                  <div className="min-w-0 flex-1 text-sm">
                    <Link href={`/stores/${storeId}/listings/${l.itemId}`} className="font-medium text-slate-800 hover:text-brand-700">
                      {l.title}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {l.itemId} {l.sku && `· SKU ${l.sku}`} {l.fulfillmentStatus === "FULFILLED" && "· shipped"}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="text-slate-900">{money(l.total, cur)}</div>
                    <div className="text-xs text-slate-500">
                      {l.qty} × {money(l.price, cur)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Totals">
            <dl className="space-y-1 text-sm">
              {[
                ["Items", o.totals.subtotal],
                ["Shipping", o.totals.shipping],
                ...(o.totals.discount ? [["Discount", -o.totals.discount]] : []),
                ...(o.totals.tax ? [["Tax (collected by eBay)", o.totals.tax]] : []),
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between text-slate-600">
                  <dt>{k}</dt>
                  <dd>{money(v as number, cur)}</dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-slate-100 pt-1 font-semibold text-slate-900">
                <dt>Order total</dt>
                <dd>{money(o.totals.total, cur)}</dd>
              </div>
              {o.fees !== null && (
                <div className="flex justify-between text-slate-500">
                  <dt>eBay fees</dt>
                  <dd>−{money(o.fees, cur)}</dd>
                </div>
              )}
              {refundedTotal(o) > 0 && (
                <div className="flex justify-between text-rose-600">
                  <dt>Refunded</dt>
                  <dd>−{money(refundedTotal(o), cur)}</dd>
                </div>
              )}
            </dl>
          </Section>

          <Section title="Tracking">
            {!o.fulfillments.length ? (
              <p className="text-sm text-slate-500">No tracking uploaded yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {o.fulfillments.map((f, i) => (
                  <li key={f.fulfillmentId || i} className="flex justify-between gap-2">
                    <span>
                      <b>{f.carrier}</b> <span className="font-mono">{f.trackingNumber}</span>
                    </span>
                    <span className="text-slate-500">{dateTime(f.shippedDate)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {o.refunds.length > 0 && (
            <Section title="Refunds">
              <ul className="space-y-1 text-sm">
                {o.refunds.map((r, i) => (
                  <li key={r.refundId || i} className="flex justify-between gap-2">
                    <span>
                      {money(r.amount, r.currency)} <Badge color={r.status === "FAILED" ? "red" : r.status === "PENDING" ? "yellow" : "green"}>{r.status.toLowerCase() || "issued"}</Badge>
                    </span>
                    <span className="text-slate-500">{dateTime(r.date)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <p className="text-xs text-slate-400">Last changed on eBay {dateTime(o.lastModifiedDate)}</p>

          {dialog === "tracking" && <TrackingDialog storeId={storeId} order={o} onClose={() => setDialog("")} onDone={done} />}
          {dialog === "refund" && <RefundDialog storeId={storeId} order={o} refundable={data.refundable} onClose={() => setDialog("")} onDone={done} />}
        </>
      )}
    </Drawer>
  );
}
