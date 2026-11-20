"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { PayoutStatus } from "@/components/finances/PayoutsTable";
import { TransactionRows } from "@/components/finances/TransactionsTable";
import { Alert, Card, Empty, Spinner, Stat } from "@/components/ui";
import { dateTime, fetcher, money } from "@/lib/api";
import { TYPE_LABEL, type PayoutDetail } from "@/lib/finances";

export default function PayoutPage() {
  const { id, payoutId } = useParams<{ id: string; payoutId: string }>();
  const { data, error } = useSWR<PayoutDetail>(`/stores/${id}/finances/payouts/${payoutId}`, fetcher);

  return (
    <div className="space-y-6">
      <Link href={`/stores/${id}/finances?tab=payouts`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> All payouts
      </Link>
      {error ? (
        <Alert>{error.message}</Alert>
      ) : !data ? (
        <div className="flex justify-center py-20 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-900">Payout {money(data.payout.amount, data.payout.currency)}</h1>
            <PayoutStatus status={data.payout.status} />
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Date" value={<span className="text-base">{dateTime(data.payout.payoutDate)}</span>} />
            <Stat
              label="Sent to"
              value={<span className="text-base">{data.payout.instrument?.nickname ?? "Bank account"}</span>}
              hint={data.payout.instrument?.last4 ? `ending ${data.payout.instrument.last4}` : undefined}
            />
            <Stat label="Transactions" value={data.payout.transactionCount} hint={<span className="font-mono">{data.payout.payoutId}</span>} />
            <Stat label="Amount" value={money(data.payout.amount, data.payout.currency)} />
          </div>
          {Object.keys(data.byType).length > 0 && (
            <div className="flex flex-wrap gap-2 text-sm">
              {Object.entries(data.byType).map(([type, b]) => (
                <span key={type} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-slate-600">
                  {TYPE_LABEL[type] ?? type} × {b.count}: <b className="text-slate-900">{money(b.amount, data.payout.currency)}</b>
                </span>
              ))}
            </div>
          )}
          <Card title="Transactions in this payout">
            {data.transactions.length ? (
              <TransactionRows storeId={id} rows={data.transactions} showPayout={false} />
            ) : (
              <Empty title="No transactions loaded for this payout yet">They are read from eBay on the next Finances refresh.</Empty>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
