"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { AddListingsPanel } from "@/components/promotions/AddListingsPanel";
import { CampaignActions } from "@/components/promotions/CampaignActions";
import { CampaignAdsTable, EditCampaignButton } from "@/components/promotions/CampaignEditor";
import { Alert, Badge, Card, Spinner, Stat } from "@/components/ui";
import { fetcher } from "@/lib/api";
import { CAMPAIGN_STATUS_COLOR, statusLabel, type CampaignDetail } from "@/lib/promotions";

const d = (s?: string) => (s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

export default function CampaignPage() {
  const { id, campaignId } = useParams<{ id: string; campaignId: string }>();
  const { data, error, mutate } = useSWR<CampaignDetail>(`/stores/${id}/promotions/campaigns/${campaignId}`, fetcher);
  const c = data?.campaign;
  const canAdd = c && c.status !== "ENDED" && c.status !== "DELETED" && c.fundingModel === "COST_PER_SALE" && !c.rulesBased;

  return (
    <div className="space-y-6">
      <Link href={`/stores/${id}/promotions`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> All campaigns
      </Link>
      {error ? (
        <Alert>{error.message}</Alert>
      ) : !data || !c ? (
        <div className="flex justify-center py-20 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold text-slate-900">{c.name}</h1>
              <Badge color={CAMPAIGN_STATUS_COLOR[c.status] ?? "gray"}>{statusLabel(c.status)}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <EditCampaignButton storeId={id} campaign={c} onDone={() => mutate()} />
              <CampaignActions storeId={id} campaign={c} onDone={() => mutate()} size="md" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Type" value={<span className="text-base">{c.fundingModel === "COST_PER_CLICK" ? "Advanced" : "Standard"}</span>} hint={c.fundingModel === "COST_PER_CLICK" ? "Cost per click" : "Cost per sale"} />
            <Stat label="Default ad rate" value={c.bidPercentage !== null ? `${c.bidPercentage}%` : "—"} />
            <Stat label="Listings" value={c.adCount} />
            <Stat label="Dates" value={<span className="text-base">{d(c.startDate)}</span>} hint={c.endDate ? `until ${d(c.endDate)}` : "No end date"} />
          </div>

          <Card title="Promoted listings">
            <CampaignAdsTable storeId={id} campaign={c} ads={data.ads} onDone={() => mutate()} />
          </Card>

          {canAdd ? (
            <Card title="Add listings">
              <AddListingsPanel storeId={id} campaign={c} onAdded={() => mutate()} />
            </Card>
          ) : (
            <Alert kind="info">
              {c.status === "ENDED"
                ? "This campaign has ended - create a new one to promote more listings."
                : "Listings for this campaign are managed on eBay (rules-based or cost-per-click campaigns)."}
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
