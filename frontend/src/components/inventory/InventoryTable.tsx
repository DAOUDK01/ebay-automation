"use client";
import { ExternalLink } from "lucide-react";
import { Badge, Button, cx } from "@/components/ui";
import { money, timeAgo } from "@/lib/api";
import type { InventoryItem, ReviseResult, StockChange } from "@/lib/inventory";

export type Edits = Record<string, { quantity?: string; price?: string }>;

/** Parse an edit row into a change (only fields that differ from eBay); null = nothing valid to send. */
export function toChange(it: InventoryItem, e: Edits[string] | undefined): StockChange | null {
  if (!e) return null;
  const c: StockChange = { itemId: it.itemId };
  if (e.quantity !== undefined && e.quantity.trim() !== "") {
    const q = Number(e.quantity);
    if (Number.isInteger(q) && q >= 0 && q !== it.quantityAvailable) c.quantity = q;
  }
  if (e.price !== undefined && e.price.trim() !== "") {
    const p = Math.round(Number(e.price) * 100) / 100;
    if (p > 0 && p !== it.price) c.price = p;
  }
  return c.quantity !== undefined || c.price !== undefined ? c : null;
}

function stockBadge(it: InventoryItem, threshold: number) {
  if (it.status === "unsold") return <Badge color="gray">Unsold</Badge>;
  if (it.status === "ended") return <Badge color="gray">{it.quantitySold ? "Sold / ended" : "Ended"}</Badge>;
  if (it.quantityAvailable <= 0) return <Badge color="red">Out of stock</Badge>;
  if (it.quantityAvailable <= threshold) return <Badge color="yellow">Low</Badge>;
  return <Badge color="green">In stock</Badge>;
}

export function InventoryTable({
  items,
  threshold,
  edits,
  setEdit,
  results,
  onEnd,
  onRelist,
  relisting,
}: {
  items: InventoryItem[];
  threshold: number;
  edits: Edits;
  setEdit: (itemId: string, field: "quantity" | "price", v: string) => void;
  results: Record<string, ReviseResult>;
  onEnd: (it: InventoryItem) => void;
  onRelist: (it: InventoryItem) => void;
  relisting: string | null;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-slate-200">
          <tr>
            <th className="table-th">Listing</th>
            <th className="table-th">Status</th>
            <th className="table-th">Available</th>
            <th className="table-th">Price</th>
            <th className="table-th">Sold</th>
            <th className="table-th">Watchers</th>
            <th className="table-th" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((it) => {
            const editable = it.status === "active" && !it.hasVariations;
            const e = edits[it.itemId];
            const dirty = !!toChange(it, e);
            const r = results[it.itemId];
            return (
              <tr key={it._id} className={cx("hover:bg-slate-50", dirty && "bg-amber-50/60")}>
                <td className="table-td">
                  <div className="flex items-center gap-3">
                    {it.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="h-10 w-10 shrink-0 rounded bg-slate-100" />
                    )}
                    <div className="min-w-0">
                      <div className="max-w-md truncate font-medium text-slate-800" title={it.title}>
                        {it.title}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>{it.sku || "no SKU"}</span>
                        <span>·</span>
                        <a className="inline-flex items-center gap-0.5 hover:text-brand-600" href={it.url || `https://www.ebay.com/itm/${it.itemId}`} target="_blank" rel="noreferrer">
                          {it.itemId} <ExternalLink className="h-3 w-3" />
                        </a>
                        {it.hasVariations && <Badge color="blue">Variations</Badge>}
                      </div>
                      {r && !r.ok && <div className="mt-1 text-xs text-rose-600">Not saved: {r.error}</div>}
                      {r?.ok && <div className="mt-1 text-xs text-emerald-600">Saved on eBay</div>}
                    </div>
                  </div>
                </td>
                <td className="table-td whitespace-nowrap">
                  {stockBadge(it, threshold)}
                  {it.status !== "active" && <div className="mt-1 text-xs text-slate-400">{timeAgo(it.endTime)}</div>}
                </td>
                <td className="table-td">
                  {editable ? (
                    <input
                      className="input w-20 py-1"
                      type="number"
                      min="0"
                      step="1"
                      aria-label={`Quantity for ${it.itemId}`}
                      value={e?.quantity ?? String(it.quantityAvailable)}
                      onChange={(ev) => setEdit(it.itemId, "quantity", ev.target.value)}
                    />
                  ) : (
                    <span className="text-slate-500">{it.status === "active" ? it.quantityAvailable : "—"}</span>
                  )}
                </td>
                <td className="table-td">
                  {editable ? (
                    <input
                      className="input w-24 py-1"
                      type="number"
                      min="0.01"
                      step="0.01"
                      aria-label={`Price for ${it.itemId}`}
                      value={e?.price ?? it.price.toFixed(2)}
                      onChange={(ev) => setEdit(it.itemId, "price", ev.target.value)}
                    />
                  ) : (
                    <span className="text-slate-600">{money(it.price, it.currency)}</span>
                  )}
                </td>
                <td className="table-td text-slate-600">{it.quantitySold}</td>
                <td className="table-td text-slate-600">{it.watchers}</td>
                <td className="table-td text-right">
                  {it.status === "active" ? (
                    <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => onEnd(it)}>
                      End
                    </Button>
                  ) : it.relistedAs ? (
                    <span className="text-xs text-slate-500">Relisted as {it.relistedAs}</span>
                  ) : (
                    <Button size="sm" variant="secondary" loading={relisting === it.itemId} onClick={() => onRelist(it)}>
                      Relist
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
