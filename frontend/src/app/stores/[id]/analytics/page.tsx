"use client";
// Placeholder - replaced when the analytics module is built (backend: src/modules/analytics).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Analytics"
      features={[
        "Impressions, views, click-through and conversion",
        "Sales charts",
        "Seller level and defect rates",
        "Listings with views but no sales"
      ]}
    />
  );
}
