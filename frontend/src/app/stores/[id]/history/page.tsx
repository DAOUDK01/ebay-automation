"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { ProposalCard } from "@/components/ProposalCard";
import { Empty, Pagination, Spinner, cx } from "@/components/ui";
import { fetcher } from "@/lib/api";
import type { Paged, Proposal } from "@/lib/types";

const VIEWS = [
  { key: "pushed,reverted,failed", label: "All changes" },
  { key: "pushed", label: "Live on eBay" },
  { key: "reverted", label: "Reverted" },
  { key: "failed", label: "Failed" },
];

export default function HistoryPage() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const [view, setView] = useState(VIEWS[0].key);
  const { data, mutate } = useSWR<Paged<Proposal>>(`/stores/${id}/proposals?page=${page}&status=${view}`, fetcher);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => (setView(v.key), setPage(1))}
            className={cx(
              "rounded-full px-3 py-1 text-sm",
              view === v.key ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      {!data ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Spinner />
        </div>
      ) : !data.total ? (
        <Empty title="No changes yet">Changes appear here once they are pushed to eBay. Every pushed change can be reverted.</Empty>
      ) : (
        <>
          <div className="space-y-4">
            {data.items.map((p) => (
              <ProposalCard key={p._id} storeId={id} p={p} onChange={() => mutate()} />
            ))}
          </div>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
