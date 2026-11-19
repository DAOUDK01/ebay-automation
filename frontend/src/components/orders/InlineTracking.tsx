"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { CARRIERS, type Order } from "@/lib/orders";
import { uploadTracking } from "./TrackingDialog";

/** Carrier + tracking number + Upload, in one table row (shipping queue). */
export function InlineTracking({ storeId, order, onDone }: { storeId: string; order: Order; onDone: () => void }) {
  const [carrier, setCarrier] = useState("USPS");
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const o = await uploadTracking(storeId, order, carrier, tracking);
    setBusy(false);
    if (o) {
      setTracking("");
      onDone();
    }
  }

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <select className="input w-28 py-1 text-xs" value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-label="Carrier">
        {CARRIERS.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <input
        className="input w-48 py-1 font-mono text-xs"
        placeholder="Tracking number"
        aria-label="Tracking number"
        value={tracking}
        onChange={(e) => setTracking(e.target.value)}
      />
      <Button size="sm" type="submit" loading={busy} disabled={!tracking.trim()}>
        Upload
      </Button>
    </form>
  );
}
