"use client";
// Placeholder - replaced when the messages module is built (backend: src/modules/messages).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Messages"
      features={[
        "Buyer messages grouped by buyer and item",
        "Unread filter and quick replies",
        "Claude-drafted answers using the listing's fitment and specifics",
        "Saved reply templates"
      ]}
    />
  );
}
