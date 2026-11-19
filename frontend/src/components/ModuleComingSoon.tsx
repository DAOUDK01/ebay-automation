"use client";
import { Construction } from "lucide-react";

/** Placeholder for an account module that isn't built yet (replaced by the real page). */
export function ModuleComingSoon({ title, features }: { title: string; features: string[] }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
          <Construction className="h-5 w-5" />
        </span>
        <div>
          <div className="font-semibold text-slate-900">{title} is being built</div>
          <div className="text-sm text-slate-500">It will appear here automatically once it&apos;s ready.</div>
        </div>
      </div>
      <ul className="mt-5 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
        {features.map((f) => (
          <li key={f} className="flex gap-2">
            <span className="text-brand-600">•</span>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
