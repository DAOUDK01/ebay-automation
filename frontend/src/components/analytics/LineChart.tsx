"use client";
import { useMemo, useRef, useState } from "react";

const W = 600;
const H = 130;
const PAD = { top: 10, right: 8, bottom: 22, left: 40 };

/** Round axis maximum with 2 gridlines above zero. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * exp * 2 >= v) ?? 10;
  return step * exp * 2;
}

const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n * 10) / 10));
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * One series over days: 2px line, recessive grid, crosshair + tooltip on hover.
 * Single series, so the card title names it (no legend).
 */
export function LineChart({
  title,
  total,
  points,
  colorClass = "text-brand-600",
  unit = "",
  periodLabel = "in 30 days",
  format,
}: {
  title: string;
  total: string;
  points: { day: string; value: number }[];
  colorClass?: string;
  unit?: string;
  /** e.g. "in 7 days" */
  periodLabel?: string;
  /** hover value formatter (e.g. money) */
  format?: (n: number) => string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const { max, xs, ys, path, area } = useMemo(() => {
    const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const xs = points.map((_, i) => PAD.left + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw));
    const ys = points.map((p) => PAD.top + ih - (p.value / max) * ih);
    const path = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
    const area = xs.length ? `${path} L${xs.at(-1)!.toFixed(1)},${PAD.top + ih} L${xs[0].toFixed(1)},${PAD.top + ih} Z` : "";
    return { max, xs, ys, path, area };
  }, [points]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = ref.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
    setHover(xs.length ? best : null);
  }

  const grid = [0, max / 2, max];
  const ticks = points.length ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [];
  const hp = hover !== null ? points[hover] : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
        <div className="text-sm text-slate-500">
          {hp ? (
            <>
              <span className="font-semibold text-slate-900">
                {format ? format(hp.value) : hp.value.toLocaleString()}
                {unit}
              </span>{" "}
              on {dayLabel(hp.day)}
            </>
          ) : (
            <>
              <span className="font-semibold text-slate-900">{total}</span> {periodLabel}
            </>
          )}
        </div>
      </div>
      <div className="relative mt-2">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className={`h-auto w-full touch-none select-none ${colorClass}`}
          role="img"
          aria-label={`${title}, ${periodLabel}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {grid.map((g) => {
            const y = PAD.top + (H - PAD.top - PAD.bottom) * (1 - g / max);
            return (
              <g key={g}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className="stroke-slate-200" strokeWidth={1} />
                <text x={PAD.left - 6} y={y + 3} textAnchor="end" className="fill-slate-400 text-[10px]">
                  {short(g)}
                </text>
              </g>
            );
          })}
          {ticks.map((i) => (
            <text key={i} x={xs[i]} y={H - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-slate-400 text-[10px]">
              {dayLabel(points[i].day)}
            </text>
          ))}
          <path d={area} fill="currentColor" fillOpacity={0.08} />
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && (
            <g>
              <line x1={xs[hover]} x2={xs[hover]} y1={PAD.top} y2={H - PAD.bottom} className="stroke-slate-300" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={xs[hover]} cy={ys[hover]} r={4.5} fill="currentColor" className="stroke-white" strokeWidth={2} />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
