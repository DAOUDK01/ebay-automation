"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { Card, Empty, Pagination, Spinner, StatusBadge } from "@/components/ui";
import { dateTime, fetcher, money } from "@/lib/api";
import type { Batch, Paged } from "@/lib/types";

export default function BatchesPage() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const { data } = useSWR<Paged<Batch>>(`/stores/${id}/batches?page=${page}`, fetcher, { refreshInterval: 5000 });

  if (!data)
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Spinner />
      </div>
    );
  if (!data.total) return <Empty title="No batches yet">Run a batch from the Overview tab.</Empty>;

  return (
    <Card title="Batches">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200">
            <tr>
              <th className="table-th">#</th>
              <th className="table-th">Status</th>
              <th className="table-th">Mode</th>
              <th className="table-th">Progress</th>
              <th className="table-th">To review</th>
              <th className="table-th">Pushed</th>
              <th className="table-th">No change</th>
              <th className="table-th">Errors</th>
              <th className="table-th">Claude cost</th>
              <th className="table-th">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((b) => (
              <tr key={b._id} className="hover:bg-slate-50">
                <td className="table-td">
                  <Link className="font-semibold text-brand-700" href={`/stores/${id}/batches/${b._id}`}>
                    #{b.number}
                  </Link>
                </td>
                <td className="table-td">
                  <StatusBadge status={b.status} />
                  {b.error && <div className="mt-1 text-xs text-amber-700">{b.error}</div>}
                </td>
                <td className="table-td text-slate-600">
                  {b.mode} · {b.trigger}
                </td>
                <td className="table-td">
                  {b.counts.processed}/{b.counts.total}
                </td>
                <td className="table-td">{b.counts.proposed}</td>
                <td className="table-td text-emerald-700">{b.counts.pushed}</td>
                <td className="table-td text-slate-500">{b.counts.noChange}</td>
                <td className="table-td text-rose-600">{b.counts.errors + b.counts.failed}</td>
                <td className="table-td">{money(b.costUsd)}</td>
                <td className="table-td text-slate-500">{dateTime(b.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
    </Card>
  );
}
