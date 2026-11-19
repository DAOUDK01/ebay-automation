"use client";
// Placeholder - replaced when the finances module is built (backend: src/modules/finances).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Finances"
      features={[
        "Available, processing and on-hold funds",
        "Payout history and details",
        "Every transaction: sales, fees, refunds, adjustments",
        "Profit per order using your costs",
        "Monthly profit & loss and CSV export"
      ]}
    />
  );
}
