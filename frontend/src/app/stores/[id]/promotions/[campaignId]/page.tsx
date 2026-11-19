"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { AddListingsPanel } from "@/components/promotions/AddListingsPanel";
import { CampaignActions } from "@/components/promotions/CampaignActions";
import { Alert, Badge, Card, Empty, Spinner, Stat } from "@/components/ui";
import { fetcher, money } from "@/lib/api";
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
            <CampaignActions storeId={id} campaign={c} onDone={() => mutate()} size="md" />
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Type" value={<span className="text-base">{c.fundingModel === "COST_PER_CLICK" ? "Advanced" : "Standard"}</span>} hint={c.fundingModel === "COST_PER_CLICK" ? "Cost per click" : "Cost per sale"} />
            <Stat label="Default ad rate" value={c.bidPercentage !== null ? `${c.bidPercentage}%` : "—"} />
            <Stat label="Listings" value={c.adCount} />
            <Stat label="Dates" value={<span className="text-base">{d(c.startDate)}</span>} hint={c.endDate ? `until ${d(c.endDate)}` : "No end date"} />
          </div>

          <Card title="Promoted listings">
            {data.ads.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Listing</th>
                      <th className="py-2 pr-3 text-right">Price</th>
                      <th className="py-2 pr-3 text-right">Ad rate</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.ads.map((a) => (
                      <tr key={a.adId}>
                        <td className="py-2 pr-3">
                          {a.listingId ? (
                            <Link href={`/stores/${id}/listings/${a.listingId}`} className="text-slate-800 hover:underline">
                              {a.title ?? a.listingId}
                            </Link>
                          ) : (
                            "—"
                          )}
                          <div className="font-mono text-xs text-slate-400">{a.listingId}</div>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(a.price)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{a.bidPercentage !== null ? `${a.bidPercentage}%` : "—"}</td>
                        <td className="py-2">
                          <Badge color={a.status === "ACTIVE" ? "green" : "gray"}>{statusLabel(a.status)}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No listings in this campaign yet" />
            )}
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
