"use client";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import type { FitmentInfo, FitmentRow } from "@/lib/types";
import { Badge, cx } from "./ui";

const SOURCE: Record<string, { label: string; color: "green" | "blue" | "indigo"; hint: string }> = {
  ebay_listings: { label: "eBay listings", color: "green", hint: "Same part number on other eBay listings - exact eBay catalog rows" },
  listing_text: { label: "Listing text", color: "blue", hint: "Stated in this listing's title/description, verified with eBay's catalog" },
  part_number_knowledge: { label: "Part # knowledge", color: "indigo", hint: "Claude's knowledge of the OEM part number, verified with eBay's catalog" },
};

/** "2001, 2002, 2003, 2005" -> "2001–2003, 2005" */
function yearRanges(years: number[]) {
  const ys = [...new Set(years)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < ys.length; i++) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
    out.push(i === j ? String(ys[i]) : `${ys[i]}–${ys[j]}`);
    i = j;
  }
  return out.join(", ");
}

export function FitmentPanel({ rows, fitment, pushing }: { rows: FitmentRow[]; fitment?: FitmentInfo | null; pushing: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const [showRefs, setShowRefs] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<string, { make: string; model: string; years: number[]; variants: number; sources: Set<string> }>();
    for (const r of rows) {
      const k = `${r.Make}|${r.Model}`;
      if (!m.has(k)) m.set(k, { make: r.Make, model: r.Model, years: [], variants: 0, sources: new Set() });
      const g = m.get(k)!;
      g.years.push(Number(r.Year));
      if (r.Trim || r.Engine) g.variants++;
      g.sources.add(r._source);
    }
    return [...m.values()].sort((a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model));
  }, [rows]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r._source] = (c[r._source] ?? 0) + 1;
    return c;
  }, [rows]);

  const refs = fitment?.references ?? [];
  const nothingFound = !rows.length;

  return (
    <div>
      <div className="label flex flex-wrap items-center gap-2">
        <span>
          Fitment {pushing ? "to add" : "found (report only)"} · {rows.length} vehicle row{rows.length === 1 ? "" : "s"}
        </span>
        {Object.entries(counts).map(([src, n]) => (
          <span key={src} title={SOURCE[src]?.hint}>
            <Badge color={SOURCE[src]?.color ?? "gray"}>
              {SOURCE[src]?.label ?? src} · {n}
            </Badge>
          </span>
        ))}
      </div>

      {fitment && (
        <p className="mb-2 text-xs text-slate-500">
          {fitment.partNumbers.length ? (
            <>
              Part number{fitment.partNumbers.length > 1 ? "s" : ""}: <span className="font-mono text-slate-700">{fitment.partNumbers.join(", ")}</span> ·{" "}
              {refs.length} other eBay listing{refs.length === 1 ? "" : "s"} with fitment
            </>
          ) : (
            "No part number found in the title or item specifics - only the listing text and Claude were used."
          )}
          {fitment.existingCount ? ` · listing already has ${fitment.existingCount} vehicle(s)` : ""}
        </p>
      )}

      {nothingFound ? (
        <p className="text-sm text-slate-500">No additional vehicles found.</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto pr-1 text-sm text-slate-700">
          {groups.map((g) => (
            <li key={`${g.make}|${g.model}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">
                {g.make} {g.model}
              </span>
              <span className="tabular-nums text-slate-600">{yearRanges(g.years)}</span>
              {g.variants > 0 && <span className="text-xs text-slate-400">{g.variants} trim/engine rows</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {rows.length > 0 && (
          <button className="inline-flex items-center gap-1 font-medium text-brand-600" onClick={() => setShowAll((v) => !v)}>
            {showAll ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} All {rows.length} rows
          </button>
        )}
        {(refs.length > 0 || (fitment?.dropped?.length ?? 0) > 0) && (
          <button className="inline-flex items-center gap-1 font-medium text-brand-600" onClick={() => setShowRefs((v) => !v)}>
            {showRefs ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Sources & dropped vehicles
          </button>
        )}
      </div>

      {showAll && (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-slate-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1.5">Year</th>
                <th className="px-2 py-1.5">Make</th>
                <th className="px-2 py-1.5">Model</th>
                <th className="px-2 py-1.5">Trim</th>
                <th className="px-2 py-1.5">Engine</th>
                <th className="px-2 py-1.5">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...rows]
                .sort((a, b) => a.Make.localeCompare(b.Make) || a.Model.localeCompare(b.Model) || a.Year.localeCompare(b.Year))
                .map((r, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1 tabular-nums">{r.Year}</td>
                    <td className="px-2 py-1">{r.Make}</td>
                    <td className="px-2 py-1">{r.Model}</td>
                    <td className={cx("px-2 py-1", !r.Trim && "text-slate-400")}>{r.Trim || "all"}</td>
                    <td className={cx("px-2 py-1", !r.Engine && "text-slate-400")}>{r.Engine || "all"}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {SOURCE[r._source]?.label ?? r._source}
                      {r._support ? ` (${r._support})` : ""}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {showRefs && (
        <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-3 text-xs">
          {refs.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-slate-600">Reference listings (same part number)</div>
              <ul className="space-y-0.5">
                {refs.map((r) => (
                  <li key={r.itemId} className="flex items-center gap-1">
                    <a href={r.url || `https://www.ebay.com/itm/${r.itemId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                      {r.title || r.itemId} <ExternalLink className="h-3 w-3" />
                    </a>
                    <span className="text-slate-400">
                      · {r.rowCount} vehicles · {r.partNumber}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(fitment?.dropped?.length ?? 0) > 0 && (
            <div>
              <div className="mb-1 font-semibold text-slate-600">Not added</div>
              <ul className="list-inside list-disc text-slate-500">
                {fitment!.dropped.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
