"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Renders listing description HTML in a sandboxed iframe (no scripts, can't touch the app),
 * auto-sized to its content - the same way eBay isolates seller descriptions.
 */
export function DescriptionFrame({ html, minHeight = 120 }: { html: string; minHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);

  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>body{margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#191919;word-wrap:break-word}
img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html || "<p style='color:#777'>No description.</p>"}</body></html>`;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const measure = () => {
      try {
        const h = frame.contentDocument?.documentElement?.scrollHeight;
        if (h) setHeight(Math.max(minHeight, Math.min(h + 4, 4000)));
      } catch {
        /* sandboxed - keep min height */
      }
    };
    frame.addEventListener("load", measure);
    const t = setTimeout(measure, 600);
    return () => {
      frame.removeEventListener("load", measure);
      clearTimeout(t);
    };
  }, [doc, minHeight]);

  return (
    <iframe
      ref={ref}
      title="Listing description"
      srcDoc={doc}
      // same-origin only so we can measure height; scripts stay disabled
      sandbox="allow-same-origin allow-popups"
      className="w-full rounded-md border border-slate-200 bg-white"
      style={{ height }}
    />
  );
}
