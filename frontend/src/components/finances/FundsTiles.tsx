"use client";
import { Stat } from "@/components/ui";
import { dateTime, money } from "@/lib/api";
import type { FinancesSummary } from "@/lib/finances";

/** Available / processing / on hold funds, straight from eBay's seller funds summary. */
export function FundsTiles({ summary }: { summary: FinancesSummary }) {
  const f = summary.funds;
  const cur = f?.currency ?? "USD";
  const last = summary.lastPayout;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Available" value={money(f?.availableFunds, cur)} hint="Ready for your next payout" />
      <Stat label="Processing" value={money(f?.processingFunds, cur)} hint="Recent sales still clearing" />
      <Stat label="On hold" value={money(f?.fundsOnHold, cur)} hint="Held by eBay (e.g. new seller, cases)" />
      <Stat
        label="Last payout"
        value={last ? money(last.amount, last.currency) : "—"}
        hint={last ? `${dateTime(last.payoutDate)}${last.instrument?.last4 ? ` · ••${last.instrument.last4}` : ""}` : "No payouts yet"}
      />
    </div>
  );
}
