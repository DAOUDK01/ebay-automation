"use client";
import { Printer } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";
import { PackingSlip } from "@/components/orders/PackingSlip";
import { useStore } from "@/components/StoreContext";
import { Alert, Button, Empty, Spinner } from "@/components/ui";
import { fetcher } from "@/lib/api";
import type { Order } from "@/lib/orders";

/** Only the slips are printed (the app shell is hidden), one slip per page. */
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #slips, #slips * { visibility: visible !important; }
  #slips { position: absolute; left: 0; top: 0; width: 100%; }
  #slips .slip { break-after: page; box-shadow: none; }
  #slips .no-print { display: none !important; }
}`;

function Slips() {
  const { id } = useParams<{ id: string }>();
  const ids = useSearchParams().get("ids") ?? "";
  const { data: store } = useStore();
  const { data, error } = useSWR<{ orders: Order[] }>(ids ? `/stores/${id}/orders/batch?ids=${encodeURIComponent(ids)}` : null, fetcher);

  if (!ids) return <Empty title="No orders selected">Select orders on the Orders page, then click “Packing slips”.</Empty>;
  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Spinner />
      </div>
    );
  return (
    <div id="slips">
      <style>{PRINT_CSS}</style>
      <div className="no-print mx-auto mb-4 flex max-w-2xl items-center justify-between">
        <span className="text-sm text-slate-600">
          {data.orders.length} packing slip{data.orders.length === 1 ? "" : "s"}
        </span>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Print
        </Button>
      </div>
      {data.orders.map((o) => (
        <PackingSlip key={o.orderId} order={o} storeName={store.store.name} />
      ))}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Slips />
    </Suspense>
  );
}
