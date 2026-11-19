"use client";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { SyncStatus } from "@/components/finances/SyncStatus";
import { CampaignActions } from "@/components/promotions/CampaignActions";
import { CreateCampaignForm } from "@/components/promotions/CreateCampaignForm";
import { ItemPromotionsList } from "@/components/promotions/ItemPromotionsList";
import { Alert, Badge, Button, Card, Empty, Spinner, Stat } from "@/components/ui";
import { fetcher, money } from "@/lib/api";
import { CAMPAIGN_STATUS_COLOR, statusLabel, type CampaignsResponse } from "@/lib/promotions";

const d = (s?: string) => (s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

export default function PromotionsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const { data, error, mutate } = useSWR<CampaignsResponse>(`/stores/${id}/promotions/campaigns`, fetcher);

  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Spinner />
      </div>
    );
  const running = data.campaigns.filter((c) => c.status === "RUNNING");
  const fees = data.campaigns.reduce((s, c) => s + (c.adFees30d ?? 0), 0);
  const sales = data.campaigns.reduce((s, c) => s + (c.promotedSales30d ?? 0), 0);

  return (
    <div className="space-y-6">
      <SyncStatus storeId={id} module="promotions" sync={data.sync} onQueued={() => setTimeout(() => mutate(), 30_000)} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Running campaigns" value={running.length} hint={`${data.campaigns.length} in total`} />
        <Stat label="Promoted listings" value={running.reduce((s, c) => s + c.adCount, 0)} hint="In running campaigns" />
        <Stat label="Sales with ad fee" value={sales} hint="Last 30 days" />
        <Stat label="Ad fees paid" value={money(fees)} hint="Last 30 days, from Finances" />
      </div>

      <Card
        title="Promoted Listings campaigns"
        actions={
          !creating && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> New campaign
            </Button>
          )
        }
      >
        {creating && (
          <div className="mb-4">
            <CreateCampaignForm
              storeId={id}
              onClose={() => setCreating(false)}
              onCreated={(c) => {
                setCreating(false);
                mutate();
                if (c) router.push(`/stores/${id}/promotions/${c.campaignId}`);
              }}
            />
          </div>
        )}
        {!data.campaigns.length ? (
          <Empty title="No campaigns yet">Create a Promoted Listings Standard campaign - you only pay when a promoted listing sells.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Campaign</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3 text-right">Ad rate</th>
                  <th className="py-2 pr-3 text-right">Listings</th>
                  <th className="py-2 pr-3 text-right">Sales (30d)</th>
                  <th className="py-2 pr-3 text-right">Ad fees (30d)</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.campaigns.map((c) => (
                  <tr key={c.campaignId}>
                    <td className="py-2 pr-3">
                      <Link href={`/stores/${id}/promotions/${c.campaignId}`} className="font-medium text-slate-800 hover:underline">
                        {c.name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {c.fundingModel === "COST_PER_CLICK" ? "Advanced (cost per click)" : "Standard (cost per sale)"} · {d(c.startDate)}
                        {c.endDate ? ` – ${d(c.endDate)}` : ""}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge color={CAMPAIGN_STATUS_COLOR[c.status] ?? "gray"}>{statusLabel(c.status)}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.bidPercentage !== null ? `${c.bidPercentage}%` : "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.adCount}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.promotedSales30d ?? 0}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(c.adFees30d ?? 0)}</td>
                    <td className="py-2">
                      <div className="flex justify-end">
                        <CampaignActions storeId={id} campaign={c} onDone={() => mutate()} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Sales and ad fees come from your Finances transactions (eBay&apos;s full ad reports are generated asynchronously and aren&apos;t shown
          here yet).
        </p>
      </Card>

      <Card title="Markdown sales & discounts">
        <ItemPromotionsList storeId={id} />
      </Card>
    </div>
  );
}
