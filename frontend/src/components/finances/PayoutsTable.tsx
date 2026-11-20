"use client";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Alert, Badge, Empty, Pagination, Spinner } from "@/components/ui";
import { dateTime, fetcher, money } from "@/lib/api";
import type { Payout } from "@/lib/finances";

const STATUS_COLOR: Record<string, "green" | "yellow" | "red" | "gray" | "blue"> = {
  SUCCEEDED: "green",
  INITIATED: "blue",
  RETRYABLE_FAILED: "yellow",
  TERMINAL_FAILED: "red",
  REVERSED: "red",
};

export function PayoutStatus({ status }: { status?: string }) {
  return <Badge color={STATUS_COLOR[status ?? ""] ?? "gray"}>{(status ?? "unknown").replace(/_/g, " ").toLowerCase()}</Badge>;
}

export function PayoutsTable({ storeId }: { storeId: string }) {
  const [page, setPage] = useState(1);
  const { data, error } = useSWR<{ items: Payout[]; total: number; page: number; pageSize: number }>(
    `/stores/${storeId}/finances/payouts?page=${page}`,
    fetcher,
  );
  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-10 text-slate-400">
        <Spinner />
      </div>
    );
  if (!data.items.length) return <Empty title="No payouts yet">eBay pays out your available funds on your payout schedule.</Empty>;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-3">Date</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">To</th>
              <th className="py-2 pr-3 text-right">Transactions</th>
              <th className="py-2 pr-3 text-right">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((p) => (
              <tr key={p.payoutId} className="hover:bg-slate-50">
                <td className="py-2 pr-3">
                  <Link href={`/stores/${storeId}/finances/payouts/${encodeURIComponent(p.payoutId)}`} className="font-medium text-slate-800 hover:underline">
                    {dateTime(p.payoutDate)}
                  </Link>
                  <div className="font-mono text-xs text-slate-400">{p.payoutId}</div>
                </td>
                <td className="py-2 pr-3">
                  <PayoutStatus status={p.status} />
                </td>
                <td className="py-2 pr-3 text-slate-600">
                  {p.instrument?.nickname ?? "Bank account"}
                  {p.instrument?.last4 ? ` ••${p.instrument.last4}` : ""}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{p.transactionCount}</td>
                <td className="py-2 pr-3 text-right font-semibold tabular-nums text-slate-900">{money(p.amount, p.currency)}</td>
                <td className="py-2 text-right">
                  <Link href={`/stores/${storeId}/finances/payouts/${encodeURIComponent(p.payoutId)}`} aria-label="Payout details">
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
    </div>
  );
}
