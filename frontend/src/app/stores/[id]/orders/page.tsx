"use client";
// Placeholder - replaced when the orders module is built (backend: src/modules/orders).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Orders"
      features={[
        "All orders with filters: awaiting shipment, shipped, cancelled",
        "Order details: buyer, address, items, totals and fees",
        "Add tracking one by one or in bulk (CSV)",
        "Print packing slips",
        "Full or partial refunds"
      ]}
    />
  );
}
