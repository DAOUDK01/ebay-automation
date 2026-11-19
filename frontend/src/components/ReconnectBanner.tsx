"use client";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "./ui";
import { toast } from "./toast";

/** Shown when an account was connected before new eBay permissions were added (orders, finances, ...). */
export function ReconnectBanner({ features }: { features: string[] }) {
  const [busy, setBusy] = useState(false);
  if (!features.length) return null;
  async function reconnect() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/ebay/connect-url");
      window.location.href = url;
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <KeyRound className="h-5 w-5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 text-sm text-amber-900">
        <b>Reconnect this eBay account</b> to turn on {features.join(", ")}. eBay needs your permission once. Your settings and
        data stay as they are.
      </div>
      <Button size="sm" onClick={reconnect} loading={busy}>
        Reconnect eBay
      </Button>
    </div>
  );
}
