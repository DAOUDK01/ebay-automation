"use client";
import { dateTime } from "@/lib/api";
import { addressLines, itemsCount, type Order } from "@/lib/orders";

/** One printable packing slip (no prices - it goes in the box). */
export function PackingSlip({ order, storeName }: { order: Order; storeName: string }) {
  return (
    <article className="slip mx-auto mb-8 max-w-2xl rounded-lg border border-slate-300 bg-white p-8 text-slate-900 print:mb-0 print:rounded-none print:border-0">
      <header className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
        <div>
          <div className="text-xl font-bold">{storeName}</div>
          <div className="text-sm text-slate-600">Packing slip</div>
        </div>
        <div className="text-right text-sm">
          <div>
            Order <b>{order.orderId}</b>
          </div>
          <div className="text-slate-600">{dateTime(order.creationDate)}</div>
          {order.shippingService && <div className="text-slate-600">{order.shippingService}</div>}
        </div>
      </header>
      <section className="grid grid-cols-2 gap-6 py-5 text-sm">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Ship to</div>
          {addressLines(order.shipTo).map((l, i) => (
            <div key={i} className={i === 0 ? "font-semibold" : ""}>
              {l}
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Buyer</div>
          <div>{order.buyer.username}</div>
          {order.buyerNotes && <div className="mt-2 rounded border border-slate-300 p-2 text-xs">Note: {order.buyerNotes}</div>}
        </div>
      </section>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-400 text-left">
            <th className="py-2 pr-2">Qty</th>
            <th className="py-2 pr-2">Item</th>
            <th className="py-2 pr-2">SKU</th>
            <th className="py-2">Item #</th>
          </tr>
        </thead>
        <tbody>
          {order.lineItems.map((l) => (
            <tr key={l.lineItemId} className="border-b border-slate-200 align-top">
              <td className="py-2 pr-2 text-lg font-bold">{l.qty}</td>
              <td className="py-2 pr-2">{l.title}</td>
              <td className="py-2 pr-2 font-mono text-xs">{l.sku || "—"}</td>
              <td className="py-2 font-mono text-xs">{l.itemId}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="mt-6 flex justify-between text-sm text-slate-600">
        <span>{itemsCount(order)} item(s)</span>
        <span>Thank you for your order!</span>
      </footer>
    </article>
  );
}
