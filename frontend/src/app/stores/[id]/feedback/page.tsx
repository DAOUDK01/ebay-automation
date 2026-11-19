"use client";
// Placeholder - replaced when the feedback module is built (backend: src/modules/feedback).
import { ModuleComingSoon } from "@/components/ModuleComingSoon";

export default function Page() {
  return (
    <ModuleComingSoon
      title="Feedback"
      features={[
        "Feedback received and left",
        "Alerts for neutral and negative feedback",
        "Reply to feedback publicly",
        "Leave feedback for buyers in one click"
      ]}
    />
  );
}
