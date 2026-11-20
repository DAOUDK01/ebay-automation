"use client";
import { useParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { AutoFeedbackCard } from "@/components/feedback/AutoFeedbackCard";
import { AwaitingFeedback } from "@/components/feedback/AwaitingFeedback";
import { FeedbackSummaryTiles } from "@/components/feedback/FeedbackSummaryTiles";
import { FeedbackTable } from "@/components/feedback/FeedbackTable";
import { Alert, Spinner } from "@/components/ui";
import { fetcher } from "@/lib/api";
import type { FeedbackSummary } from "@/lib/feedback";

export default function FeedbackPage() {
  const { id } = useParams<{ id: string }>();
  const { mutate: globalMutate } = useSWRConfig();
  const { data, error, mutate } = useSWR<FeedbackSummary>(`/stores/${id}/feedback/summary`, fetcher);
  // after a reply / leave: refresh tiles and the sidebar badge
  const refresh = () => {
    mutate();
    globalMutate(`/stores/${id}/counts`);
  };

  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-4">
      <FeedbackSummaryTiles s={data} />
      {data.needsReply > 0 && (
        <Alert kind="warning">
          {data.needsReply} neutral/negative {data.needsReply === 1 ? "rating has" : "ratings have"} no reply yet. A calm public reply shows future
          buyers you fix problems.
        </Alert>
      )}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <FeedbackTable storeId={id} onChanged={refresh} />
        </div>
        <div className="min-w-0 space-y-4">
          <AwaitingFeedback storeId={id} defaultText={data.settings.autoText} onChanged={refresh} />
          <AutoFeedbackCard storeId={id} settings={data.settings} onSaved={() => mutate()} />
        </div>
      </div>
    </div>
  );
}
