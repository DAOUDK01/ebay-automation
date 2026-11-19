"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";
import { FundsTiles } from "@/components/finances/FundsTiles";
import { PayoutsTable } from "@/components/finances/PayoutsTable";
import { PnlTable } from "@/components/finances/PnlTable";
import { ProfitTable } from "@/components/finances/ProfitTable";
import { SyncStatus } from "@/components/finances/SyncStatus";
import { TransactionsTable } from "@/components/finances/TransactionsTable";
import { Alert, Card, Spinner, cx } from "@/components/ui";
import { fetcher } from "@/lib/api";
import type { FinancesSummary } from "@/lib/finances";

const TABS = [
  { key: "profit", label: "Profit per order" },
  { key: "pnl", label: "Monthly P&L" },
  { key: "transactions", label: "Transactions" },
  { key: "payouts", label: "Payouts" },
] as const;

function FinancesPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get("tab") as (typeof TABS)[number]["key"]) || "profit";
  const { data, error, mutate } = useSWR<FinancesSummary>(`/stores/${id}/finances/summary`, fetcher);

  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Spinner />
      </div>
    );

  return (
    <div className="space-y-6">
      {data.needsDigitalSignature && (
        <Alert kind="warning">
          This account is on {data.marketplaceId}. eBay requires digital signatures on Finances API calls for EU and UK sellers, which this app
          doesn&apos;t support yet - so funds, payouts and transactions can&apos;t be loaded for this account.
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SyncStatus storeId={id} module="finances" sync={data.sync} onQueued={() => setTimeout(() => mutate(), 30_000)} />
        <span className="text-xs text-slate-500">Read-only: payouts are made by eBay, this app never moves money.</span>
      </div>
      <FundsTiles summary={data} />

      <Card className="overflow-hidden">
        <div className="-mx-5 -mt-5 mb-5 flex gap-1 overflow-x-auto border-b border-slate-200 px-3">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => router.replace(`/stores/${id}/finances${t.key === "profit" ? "" : `?tab=${t.key}`}`, { scroll: false })}
              className={cx(
                "whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition",
                tab === t.key ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "profit" && <ProfitTable storeId={id} />}
        {tab === "pnl" && <PnlTable storeId={id} />}
        {tab === "transactions" && <TransactionsTable storeId={id} />}
        {tab === "payouts" && <PayoutsTable storeId={id} />}
      </Card>

      <p className="text-xs text-slate-500">
        Note: EU and UK accounts need eBay digital signatures for the Finances API, which aren&apos;t supported yet.
      </p>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <FinancesPage />
    </Suspense>
  );
}
