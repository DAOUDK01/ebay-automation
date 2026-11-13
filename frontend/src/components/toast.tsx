"use client";
import { useEffect, useState } from "react";

type Toast = { id: number; kind: "success" | "error" | "info"; text: string };

/** Fire-and-forget notifications: toast.success("Saved") */
export const toast = {
  success: (text: string) => emit("success", text),
  error: (text: string) => emit("error", text),
  info: (text: string) => emit("info", text),
};

function emit(kind: Toast["kind"], text: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("app-toast", { detail: { kind, text } }));
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const { kind, text } = (e as CustomEvent).detail;
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, kind, text }]);
      setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5000);
    };
    window.addEventListener("app-toast", on);
    return () => window.removeEventListener("app-toast", on);
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-lg px-4 py-3 text-sm shadow-lg ${
            t.kind === "error" ? "bg-rose-600 text-white" : t.kind === "success" ? "bg-emerald-600 text-white" : "bg-slate-800 text-white"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
