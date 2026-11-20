"use client";
import useSWR from "swr";
import { Badge, Empty, Spinner } from "@/components/ui";
import { fetcher } from "@/lib/api";
import { CAMPAIGN_STATUS_COLOR, PROMOTION_TYPE_LABEL, statusLabel, type ItemPromotion } from "@/lib/promotions";

const d = (s?: string) => (s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

/** Markdown sales and other item promotions (view only - create them in Seller Hub). */
export function ItemPromotionsList({ storeId }: { storeId: string }) {
  const { data } = useSWR<{ promotions: ItemPromotion[] }>(`/stores/${storeId}/promotions/item-promotions`, fetcher);
  if (!data)
    return (
      <div className="flex justify-center py-6 text-slate-400">
        <Spinner />
      </div>
    );
  if (!data.promotions.length) return <Empty title="No markdown sales or discounts">Create them in eBay Seller Hub → Marketing.</Empty>;
  return (
    <ul className="divide-y divide-slate-100">
      {data.promotions.map((p) => (
        <li key={p.promotionId} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-800">{p.name}</div>
            <div className="text-xs text-slate-500">
              {PROMOTION_TYPE_LABEL[p.type] ?? statusLabel(p.type)} · {d(p.startDate)} – {d(p.endDate)}
              {p.description ? ` · ${p.description}` : ""}
            </div>
          </div>
          <Badge color={CAMPAIGN_STATUS_COLOR[p.status] ?? "gray"}>{statusLabel(p.status)}</Badge>
        </li>
      ))}
    </ul>
  );
}
