"use client";
// Placeholder - replaced when the inventory module is built (backend: src/modules/inventory).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Inventory & restock"
      features={[
        "Out-of-stock and low-stock lists",
        "Bulk quantity and price edits",
        "Relist ended or unsold listings",
        "End listings"
      ]}
    />
  );
}
