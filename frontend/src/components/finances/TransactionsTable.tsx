"use client";
import { Download } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Alert, Badge, Button, Empty, Pagination, Spinner, cx } from "@/components/ui";
import { fetcher, money } from "@/lib/api";
import { TRANSACTION_TYPES, TYPE_LABEL, type Transaction, type TransactionsPage } from "@/lib/finances";

const TYPE_COLOR: Record<string, "green" | "red" | "yellow" | "blue" | "gray" | "indigo"> = {
  SALE: "green",
  REFUND: "red",
  DISPUTE: "red",
  CREDIT: "blue",
  SHIPPING_LABEL: "indigo",
  NON_SALE_CHARGE: "yellow",
  TRANSFER: "gray",
};

export function TxTypeBadge({ t }: { t: Pick<Transaction, "type" | "feeType"> }) {
  const label = t.type === "NON_SALE_CHARGE" && t.feeType ? t.feeType.replace(/_/g, " ").toLowerCase() : TYPE_LABEL[t.type] ?? t.type;
  return <Badge color={TYPE_COLOR[t.type] ?? "gray"}>{label}</Badge>;
}

/** One row: date, type, what it's about, amount (signed) and fees. */
export function TransactionRows({ storeId, rows, showPayout = true }: { storeId: string; rows: Transaction[]; showPayout?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Type</th>
            <th className="py-2 pr-3">Details</th>
            <th className="py-2 pr-3 text-right">Amount</th>
            <th className="py-2 pr-3 text-right">eBay fees</th>
            {showPayout && <th className="py-2">Payout</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((t) => (
            <tr key={t._id}>
              <td className="whitespace-nowrap py-2 pr-3 text-slate-600">{new Date(t.date).toLocaleDateString()}</td>
              <td className="py-2 pr-3">
                <TxTypeBadge t={t} />
              </td>
              <td className="max-w-sm py-2 pr-3">
                <div className="truncate text-slate-700">
                  {t.lines?.[0]?.title ?? t.memo ?? (t.orderId ? `Order ${t.orderId}` : t.transactionId)}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {[t.orderId && `Order ${t.orderId}`, t.buyer, t.status?.replace(/_/g, " ").toLowerCase()].filter(Boolean).join(" · ")}
                </div>
              </td>
              <td className={cx("whitespace-nowrap py-2 pr-3 text-right font-medium tabular-nums", t.amount < 0 ? "text-rose-600" : "text-slate-900")}>
                {money(t.amount, t.currency)}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums text-slate-600">{t.feeTotal ? money(t.feeTotal, t.currency) : "—"}</td>
              {showPayout && (
                <td className="py-2 text-xs">
                  {t.payoutId ? (
                    <Link href={`/stores/${storeId}/finances/payouts/${encodeURIComponent(t.payoutId)}`} className="font-mono text-brand-700 hover:underline">
                      {t.payoutId}
                    </Link>
                  ) : (
                    <span className="text-slate-400">Not paid out yet</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every transaction with type / date / search filters and CSV export of the filtered set. */
export function TransactionsTable({ storeId }: { storeId: string }) {
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const filters = new URLSearchParams({ type, from, to, q: search });
  for (const [k, v] of [...filters.entries()]) if (!v) filters.delete(k);
  const { data, error } = useSWR<TransactionsPage>(`/stores/${storeId}/finances/transactions?${filters}&page=${page}`, fetcher);
  const cur = data?.items[0]?.currency ?? "USD";

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
          setPage(1);
        }}
      >
        <label className="text-xs text-slate-500">
          Type
          <select className="input mt-1 w-44" value={type} onChange={(e) => (setType(e.target.value), setPage(1))}>
            <option value="">All types</option>
            {TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          From
          <input type="date" className="input mt-1 w-40" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" className="input mt-1 w-40" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
        </label>
        <label className="min-w-[12rem] flex-1 text-xs text-slate-500">
          Search
          <input className="input mt-1" placeholder="Order ID, buyer or item ID" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        <a href={`/api/stores/${storeId}/finances/transactions.csv?${filters}`} className="ml-auto" download>
          <Button type="button" variant="secondary">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </a>
      </form>

      {error && <Alert>{error.message}</Alert>}
      {!data ? (
        <div className="flex justify-center py-10 text-slate-400">
          <Spinner />
        </div>
      ) : !data.items.length ? (
        <Empty title="No transactions match">Try another type or date range.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap gap-4 text-sm text-slate-600">
            <span>
              Net of these: <b className={data.totals.amount < 0 ? "text-rose-600" : "text-slate-900"}>{money(data.totals.amount, cur)}</b>
            </span>
            <span>
              eBay fees: <b className="text-slate-900">{money(data.totals.fees, cur)}</b>
            </span>
          </div>
          <TransactionRows storeId={storeId} rows={data.items} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
