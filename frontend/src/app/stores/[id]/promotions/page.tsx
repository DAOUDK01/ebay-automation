"use client";
// Placeholder - replaced when the promotions module is built (backend: src/modules/promotions).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Promotions"
      features={[
        "Promoted Listings campaigns: create, pause, end",
        "Add listings with an ad rate",
        "Campaign performance",
        "Markdown sales"
      ]}
    />
  );
}
