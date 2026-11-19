"use client";
// Placeholder - replaced when the shipping module is built (backend: src/modules/shipping).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Shipping"
      features={[
        "Orders awaiting shipment with tracking upload",
        "Bulk-apply the suggested shipping policy",
        "Handling-time overview"
      ]}
    />
  );
}
