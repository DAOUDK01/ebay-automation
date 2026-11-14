"use client";
import { ArrowLeft, ExternalLink, History, Pencil, Eye, WandSparkles } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";
import { ListingEditor } from "@/components/listing/ListingEditor";
import { ListingPreview } from "@/components/listing/ListingPreview";
import { ProposalCard } from "@/components/ProposalCard";
import { useStore } from "@/components/StoreContext";
import { toast } from "@/components/toast";
import { Alert, Button, Empty, Spinner, cx } from "@/components/ui";
import { api, fetcher, money, timeAgo } from "@/lib/api";
import type { ListingDetails, Proposal } from "@/lib/types";

const TABS = [
  { key: "preview", label: "Preview", icon: Eye },
  { key: "edit", label: "Edit", icon: Pencil },
  { key: "history", label: "History", icon: History },
] as const;

function ListingPage() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get("tab") as (typeof TABS)[number]["key"]) || "preview";
  const { data: storeData } = useStore();
  const { data, error, isLoading, mutate } = useSWR<ListingDetails>(`/stores/${id}/listings/${itemId}/details`, fetcher, {
    revalidateOnFocus: false,
  });
  const history = useSWR<{ proposals: Proposal[] }>(tab === "history" ? `/stores/${id}/listings/${itemId}/history` : null, fetcher);

  const setTab = (t: string) => router.replace(`/stores/${id}/listings/${itemId}${t === "preview" ? "" : `?tab=${t}`}`, { scroll: false });

  async function optimize() {
    try {
      const r = await api<{ duplicate: boolean }>(`/stores/${id}/run`, { body: { itemIds: [itemId] } });
      toast[r.duplicate ? "info" : "success"](r.duplicate ? "A batch is already queued - try again when it finishes" : "Queued - results appear in Review & batches");
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-5">
      <Link href={`/stores/${id}/listings`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> All listings
      </Link>

      {isLoading ? (
        <div className="flex flex-col items-center gap-3 py-24 text-slate-400">
          <Spinner />
          <span className="text-sm">Loading the listing from eBay…</span>
        </div>
      ) : error ? (
        <Alert>{error.message}</Alert>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              {data.item.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={data.item.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-slate-200 object-cover" />
              )}
              <div className="min-w-0">
                <h1 className="text-lg font-semibold leading-snug text-slate-900">{data.item.title}</h1>
                <p className="mt-0.5 text-sm text-slate-500">
                  {data.item.itemId}
                  {data.item.sku && ` · ${data.item.sku}`} · {money(data.item.price, data.item.currency)} · {data.item.categoryName}
                  {data.listing.lastProcessedAt ? ` · optimized ${timeAgo(data.listing.lastProcessedAt)}` : " · not optimized yet"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={optimize}>
                <WandSparkles className="h-3.5 w-3.5" /> Optimize now
              </Button>
              <a
                href={data.item.url || `https://www.ebay.com/itm/${itemId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              >
                View on eBay <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          <div className="flex gap-1 border-b border-slate-200">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cx(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition",
                  tab === t.key ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
                )}
              >
                <t.icon className="h-4 w-4" /> {t.label}
              </button>
            ))}
          </div>

          {tab === "preview" && <ListingPreview item={data.item} storeName={storeData.store.ebayUserId || storeData.store.name} />}
          {tab === "edit" && (
            <ListingEditor
              storeId={id}
              item={data.item}
              aspects={data.aspects}
              onSaved={() => {
                mutate();
                history.mutate();
              }}
            />
          )}
          {tab === "history" &&
            (!history.data ? (
              <div className="flex justify-center py-16 text-slate-400">
                <Spinner />
              </div>
            ) : !history.data.proposals.length ? (
              <Empty title="No changes yet">Optimizer suggestions and your manual edits for this listing appear here.</Empty>
            ) : (
              <div className="space-y-4">
                {history.data.proposals.map((p) => (
                  <ProposalCard key={p._id} storeId={id} p={p} onChange={() => (history.mutate(), mutate())} />
                ))}
              </div>
            ))}
        </>
      ) : null}
    </div>
  );
}

export default function ListingDetailPage() {
  return (
    <Suspense>
      <ListingPage />
    </Suspense>
  );
}
