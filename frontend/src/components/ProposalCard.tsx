"use client";
import { useEffect, useState } from "react";
import { api, money } from "@/lib/api";
import type { FitmentRow, Proposal } from "@/lib/types";
import { FitmentPanel } from "./FitmentPanel";
import { toast } from "./toast";
import { Badge, Button, StatusBadge, cx } from "./ui";

/** One listing inside a batch: before/after, editable title & price, approve / reject / revert. */
export function ProposalCard({ storeId, p, onChange }: { storeId: string; p: Proposal; onChange: () => void }) {
  const editable = ["proposed", "approved", "rejected"].includes(p.status);
  const [title, setTitle] = useState(p.changes.title ?? "");
  const [price, setPrice] = useState(p.changes.price?.toString() ?? "");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setTitle(p.changes.title ?? "");
    setPrice(p.changes.price?.toString() ?? "");
  }, [p.changes.title, p.changes.price]);

  const b = p.before ?? ({} as Proposal["before"]);
  const dirty = (title || "") !== (p.changes.title ?? "") || (price || "") !== (p.changes.price?.toString() ?? "");
  const newSpecs = Object.entries(p.changes.itemSpecifics ?? {}).filter(
    ([k, v]) => JSON.stringify(b.itemSpecifics?.[k]) !== JSON.stringify(v),
  );
  // rows with their source; older proposals stored rows without _source
  const compat = (p.suggestion?.suggested_compatibility_rows ?? p.changes.compatibilityAdd ?? []).map((r) => {
    const row = r as Record<string, string>;
    return {
      ...row,
      Year: row.Year ?? "",
      Make: row.Make ?? "",
      Model: row.Model ?? "",
      _source: (row._source as FitmentRow["_source"]) ?? "listing_text",
      _support: row._support ?? "",
    } satisfies FitmentRow;
  });

  async function patch(body: Record<string, unknown>, ok: string) {
    setBusy(String(body.status ?? "save"));
    try {
      await api(`/stores/${storeId}/proposals/${p._id}`, { method: "PATCH", body });
      toast.success(ok);
      onChange();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  }

  async function revert() {
    if (!confirm("Restore the previous title / price / item specifics on eBay?")) return;
    setBusy("revert");
    try {
      await api(`/stores/${storeId}/proposals/${p._id}/revert`, { method: "POST" });
      toast.success("Reverted on eBay");
      onChange();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  }

  const editsBody = () => ({ title: title.trim() || null, price: price ? Number(price) : null });

  return (
    <div
      className={cx(
        "rounded-xl border bg-white shadow-sm",
        p.status === "approved" ? "border-brand-500" : p.status === "rejected" ? "border-slate-200 opacity-60" : "border-slate-200",
      )}
    >
      <div className="flex flex-wrap items-start gap-4 p-4">
        {b.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.imageUrl} alt="" className="h-16 w-16 rounded-md border border-slate-200 object-cover" />
        ) : (
          <div className="h-16 w-16 rounded-md bg-slate-100" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={p.status} />
            {p.suggestion?.confidence && <Badge color="blue">{p.suggestion.confidence} confidence</Badge>}
            <a href={b.url || `https://www.ebay.com/itm/${p.itemId}`} target="_blank" rel="noreferrer" className="text-xs text-slate-500 hover:underline">
              {p.itemId} ↗
            </a>
            <span className="text-xs text-slate-400">
              {b.categoryName} · {b.condition}
            </span>
          </div>
          <div className="mt-1 text-sm text-slate-500">
            <span className="text-xs uppercase tracking-wide text-slate-400">Current: </span>
            {b.title}
          </div>
          {p.error && <div className="mt-1 text-sm text-rose-600">{p.error}</div>}
          {!!p.warnings?.length && <div className="mt-1 text-xs text-amber-700">eBay warnings: {p.warnings.join(" | ")}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && (
            <>
              {p.status !== "approved" && (
                <Button
                  size="sm"
                  variant="success"
                  loading={busy === "approved"}
                  onClick={() => patch({ ...(dirty ? editsBody() : {}), status: "approved" }, "Approved")}
                >
                  Approve
                </Button>
              )}
              {p.status !== "rejected" && (
                <Button size="sm" variant="secondary" loading={busy === "rejected"} onClick={() => patch({ status: "rejected" }, "Rejected")}>
                  Reject
                </Button>
              )}
              {p.status === "rejected" && (
                <Button size="sm" variant="ghost" onClick={() => patch({ status: "proposed" }, "Moved back to review")}>
                  Undo
                </Button>
              )}
            </>
          )}
          {p.status === "pushed" && (
            <Button size="sm" variant="secondary" loading={busy === "revert"} onClick={revert}>
              Revert
            </Button>
          )}
        </div>
      </div>

      {(editable || p.status === "pushed" || p.status === "reverted" || p.status === "failed") && Object.keys(p.changes).length > 0 && (
        <div className="grid gap-4 border-t border-slate-100 p-4 md:grid-cols-[1fr_200px]">
          <div>
            <label className="label">
              New title <span className={cx("normal-case", title.length > 80 ? "text-rose-600" : "text-slate-400")}>({title.length}/80)</span>
            </label>
            {editable ? (
              <input className="input" value={title} maxLength={80} placeholder="(keep current title)" onChange={(e) => setTitle(e.target.value)} />
            ) : (
              <div className="text-sm">{p.changes.title ?? <span className="text-slate-400">unchanged</span>}</div>
            )}
            {p.suggestion?.title_reason && <p className="mt-1 text-xs text-slate-500">{p.suggestion.title_reason}</p>}
          </div>
          <div>
            <label className="label">Price (current {money(b.price, b.currency)})</label>
            {editable ? (
              <input className="input" type="number" step="0.01" min="0" value={price} placeholder="keep" onChange={(e) => setPrice(e.target.value)} />
            ) : (
              <div className="text-sm">{p.changes.price ? money(p.changes.price, b.currency) : <span className="text-slate-400">unchanged</span>}</div>
            )}
          </div>
          {editable && dirty && (
            <div className="md:col-span-2">
              <Button size="sm" variant="secondary" loading={busy === "save"} onClick={() => patch(editsBody(), "Edits saved")}>
                Save edits
              </Button>
            </div>
          )}
        </div>
      )}

      {(newSpecs.length > 0 || compat.length > 0 || p.fitment) && (
        <div className="grid gap-4 border-t border-slate-100 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {newSpecs.length > 0 && (
            <div>
              <div className="label">Item specifics to add</div>
              <ul className="space-y-0.5 text-sm">
                {newSpecs.map(([k, v]) => (
                  <li key={k}>
                    <span className="font-medium">{k}:</span> {v.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(compat.length > 0 || p.fitment) && (
            <div className={cx(!newSpecs.length && "md:col-span-2")}>
              <FitmentPanel rows={compat} fitment={p.fitment} pushing={Boolean(p.changes.compatibilityAdd?.length)} />
            </div>
          )}
        </div>
      )}

      <div className="border-t border-slate-100 px-4 py-2">
        <button className="text-xs font-medium text-brand-600" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide details" : "Show Claude's reasoning, competitors & notes"}
        </button>
        {open && (
          <div className="mt-3 space-y-3 pb-2 text-sm">
            {p.suggestion?.price_reason && (
              <p>
                <b>Price:</b> {p.suggestion.price_reason} (suggested {money(p.suggestion.recommended_price)})
              </p>
            )}
            {p.suggestion?.shipping_notes && (
              <p>
                <b>Shipping advice:</b> {p.suggestion.shipping_notes}
              </p>
            )}
            {p.suggestion?.other_notes && (
              <p>
                <b>Other:</b> {p.suggestion.other_notes}
              </p>
            )}
            {!!p.notes?.length && (
              <ul className="list-inside list-disc text-xs text-slate-500">
                {p.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            {!!p.competitors?.length && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400">
                    <th className="py-1">Competitor</th>
                    <th>Price</th>
                    <th>Ship</th>
                    <th>Feedback</th>
                  </tr>
                </thead>
                <tbody>
                  {p.competitors.map((c, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="max-w-md truncate py-1 pr-2">
                        {c.url ? (
                          <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
                            {c.title}
                          </a>
                        ) : (
                          c.title
                        )}
                      </td>
                      <td>{money(c.price)}</td>
                      <td>{c.shipping === null ? "?" : c.shipping === 0 ? "free" : money(c.shipping)}</td>
                      <td>{c.sellerFeedback ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-slate-400">Claude cost for this listing: {money(p.costUsd)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
