"use client";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Alert, Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";
import type { BulkTrackingRow } from "@/lib/orders";
import { Modal } from "./Modal";

/** CSV (orderId, carrier, tracking) -> preview (dry run) -> confirm -> upload one by one. */
export function BulkTrackingDialog({ storeId, onClose, onDone }: { storeId: string; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [rows, setRows] = useState<BulkTrackingRow[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<number | null>(null);
  const ready = rows?.filter((r) => r.ok).length ?? 0;

  async function readFile(f: File | undefined) {
    if (!f) return;
    setCsv(await f.text());
    setRows(null);
  }

  async function preview() {
    setBusy(true);
    try {
      const r = await api<{ rows: BulkTrackingRow[]; errors: string[] }>(`/stores/${storeId}/orders/bulk-tracking`, { body: { csv, dryRun: true } });
      setRows(r.rows);
      setErrors(r.errors);
      setUploaded(null);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!confirm(`Upload ${ready} tracking number${ready === 1 ? "" : "s"} to eBay? Each order is marked shipped and the buyer is emailed.`)) return;
    setBusy(true);
    try {
      const r = await api<{ rows: BulkTrackingRow[]; errors: string[]; uploaded: number }>(`/stores/${storeId}/orders/bulk-tracking`, { body: { csv } });
      setRows(r.rows);
      setErrors(r.errors);
      setUploaded(r.uploaded);
      const failed = r.rows.filter((x) => x.error).length;
      toast[failed ? "error" : "success"](`${r.uploaded} uploaded${failed ? `, ${failed} failed` : ""}`);
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title="Upload tracking from CSV"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {uploaded !== null ? "Close" : "Cancel"}
          </Button>
          {uploaded === null &&
            (rows ? (
              <Button onClick={upload} loading={busy} disabled={!ready}>
                Upload {ready} to eBay
              </Button>
            ) : (
              <Button onClick={preview} loading={busy} disabled={!csv.trim()}>
                Check
              </Button>
            ))}
        </>
      }
    >
      {!rows ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Three columns: <code>order id, carrier, tracking</code>. A header row is optional (then the columns can be in any order). eBay order
            numbers or legacy order IDs both work.
          </p>
          <input type="file" accept=".csv,.txt,text/csv" className="text-sm" onChange={(e) => readFile(e.target.files?.[0])} />
          <textarea
            className="input h-40 font-mono text-xs"
            placeholder={"order id,carrier,tracking\n12-34567-89012,USPS,9400111899223344556677\n12-34567-89013,UPS,1Z999AA10123456784"}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {errors.length > 0 && (
            <Alert kind="warning">
              {errors.slice(0, 5).map((e) => (
                <div key={e}>{e}</div>
              ))}
              {errors.length > 5 && <div>…and {errors.length - 5} more</div>}
            </Alert>
          )}
          <div className="max-h-96 overflow-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className="table-th">Line</th>
                  <th className="table-th">Order</th>
                  <th className="table-th">Carrier</th>
                  <th className="table-th">Tracking</th>
                  <th className="table-th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.line}>
                    <td className="table-td text-slate-400">{r.line}</td>
                    <td className="table-td">
                      <div className="font-medium">{r.input}</div>
                      {r.buyer && <div className="max-w-[16rem] truncate text-xs text-slate-500">{r.buyer} · {r.title}</div>}
                    </td>
                    <td className="table-td">{r.carrier}</td>
                    <td className="table-td font-mono text-xs">{r.trackingNumber}</td>
                    <td className="table-td">
                      {r.error ? (
                        <span className="text-xs text-rose-600">{r.error}</span>
                      ) : r.problem ? (
                        <Badge color="gray">{r.problem}</Badge>
                      ) : uploaded !== null ? (
                        <Badge color="green">uploaded</Badge>
                      ) : (
                        <Badge color="blue">ready</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {uploaded === null && (
            <button className="text-sm text-brand-700 hover:underline" onClick={() => setRows(null)}>
              ← Edit CSV
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
