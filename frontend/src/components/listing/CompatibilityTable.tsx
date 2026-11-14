"use client";
import { Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { CompatRow } from "@/lib/types";

const PAGE = 50;

/** Searchable fitment table; pass onRemove to make rows removable (edit mode). */
export function CompatibilityTable({
  rows,
  onRemove,
  highlight,
}: {
  rows: CompatRow[];
  onRemove?: (row: CompatRow) => void;
  /** rows to highlight as new (edit mode) */
  highlight?: Set<string>;
}) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const sorted = [...rows].sort(
      (a, b) => a.Make.localeCompare(b.Make) || a.Model.localeCompare(b.Model) || a.Year.localeCompare(b.Year) || (a.Trim ?? "").localeCompare(b.Trim ?? ""),
    );
    return words.length
      ? sorted.filter((r) => {
          const hay = `${r.Year} ${r.Make} ${r.Model} ${r.Trim ?? ""} ${r.Engine ?? ""}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
      : sorted;
  }, [rows, q]);

  if (!rows.length) return <p className="text-sm text-slate-500">No vehicles listed.</p>;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input pl-8" placeholder="Filter: e.g. 2009 quattro" value={q} onChange={(e) => (setQ(e.target.value), setLimit(PAGE))} />
        </div>
        <span className="text-xs text-slate-500">
          {filtered.length === rows.length ? `${rows.length} vehicles` : `${filtered.length} of ${rows.length} vehicles`}
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Year</th>
              <th className="px-3 py-2">Make</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Trim</th>
              <th className="px-3 py-2">Engine</th>
              {onRemove && <th className="w-10 px-2 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.slice(0, limit).map((r, i) => {
              const key = `${r.Year}|${r.Make}|${r.Model}|${r.Trim ?? ""}|${r.Engine ?? ""}`.toLowerCase();
              return (
                <tr key={key + i} className={highlight?.has(key) ? "bg-emerald-50/60" : undefined}>
                  <td className="px-3 py-1.5 tabular-nums">{r.Year}</td>
                  <td className="px-3 py-1.5">{r.Make}</td>
                  <td className="px-3 py-1.5">{r.Model}</td>
                  <td className="px-3 py-1.5 text-slate-600">{r.Trim || <span className="text-slate-400">All</span>}</td>
                  <td className="px-3 py-1.5 text-slate-600">{r.Engine || <span className="text-slate-400">All</span>}</td>
                  {onRemove && (
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => onRemove(r)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Remove vehicle">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > limit && (
        <button className="mt-2 text-sm font-medium text-brand-600 hover:underline" onClick={() => setLimit((l) => l + PAGE * 4)}>
          Show more ({filtered.length - limit} remaining)
        </button>
      )}
    </div>
  );
}
