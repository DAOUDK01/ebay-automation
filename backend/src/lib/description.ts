/**
 * Branded "A+" listing description. Claude writes the words (DescriptionContent); this file lays them out
 * in the store's branded template (styled after the store banner: dark band, red accent, bold italic
 * wordmark, spaced caps, trust badges). Output is eBay-safe: inline styles only, no scripts, no forms,
 * no off-eBay links, every piece of text HTML-escaped.
 */
import type { StoreSettings } from "../models/Store";
import type { DescriptionContent } from "./claude";
import type { CompatRow, Specifics } from "./ebay/types";

export const APLUS_MARKER = "<!-- lo-aplus:v1 -->";
const NOTES_START = "<!-- lo-notes -->";
const NOTES_END = "<!-- /lo-notes -->";

type Brand = StoreSettings["modules"]["description"];

export interface AplusInput {
  content: DescriptionContent;
  title: string;
  condition: string;
  pictures: string[];
  specifics: Specifics;
  compatibility: CompatRow[];
  /** the listing's current description HTML (for "Seller notes") */
  currentHtml?: string;
  brand: Brand;
  /** fallback brand name (eBay store / user id) */
  storeName: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Description HTML -> readable plain text (paragraphs/list items/rows become new lines). */
export function descriptionToText(html: string): string {
  return (html || "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const isAplus = (html?: string) => Boolean(html?.includes(APLUS_MARKER));

/** The seller's own notes: the text kept from before our first A+ rewrite, or the whole current description. */
export function originalNotes(html?: string): string {
  if (!html) return "";
  if (isAplus(html)) {
    const a = html.indexOf(NOTES_START);
    const b = html.indexOf(NOTES_END);
    return a >= 0 && b > a ? descriptionToText(html.slice(a + NOTES_START.length, b)) : "";
  }
  return descriptionToText(html);
}

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** eBay doesn't allow links or contact details that take buyers off eBay. */
export const cleanText = (s: string) =>
  String(s ?? "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();

const txt = (s: string) => esc(cleanText(s));
const multiline = (s: string) => txt(s).replace(/\n/g, "<br>");
const httpsOnly = (u: string) => (/^https:\/\/[^\s"'<>]+$/i.test(u || "") ? u : "");

/** 2016,2017,2018,2020 -> "2016-2018, 2020" */
export function yearRuns(years: number[]): string {
  const ys = [...new Set(years.filter((y) => Number.isFinite(y)))].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < ys.length; ) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
    runs.push(i === j ? String(ys[i]) : `${ys[i]}-${ys[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** Compatibility rows grouped by make + model with their years, most years first. */
export function groupFitment(rows: CompatRow[]): { vehicle: string; years: string; count: number }[] {
  const by = new Map<string, { vehicle: string; years: number[] }>();
  for (const r of rows) {
    const make = (r.Make ?? "").trim();
    const model = (r.Model ?? "").trim();
    if (!make && !model) continue;
    const key = `${make}|${model}`.toLowerCase();
    const g = by.get(key) ?? { vehicle: `${make} ${model}`.trim(), years: [] };
    const y = Number(r.Year);
    if (y) g.years.push(y);
    by.set(key, g);
  }
  return [...by.values()]
    .map((g) => ({ vehicle: g.vehicle, years: yearRuns(g.years), count: new Set(g.years).size }))
    .sort((a, b) => b.count - a.count || a.vehicle.localeCompare(b.vehicle));
}

const SPEC_ORDER = [
  "Brand",
  "Manufacturer Part Number",
  "OE/OEM Part Number",
  "Interchange Part Number",
  "Other Part Number",
  "Placement on Vehicle",
  "Type",
  "Color",
  "Material",
  "Fitment Type",
];

function specRows(specs: Specifics, max = 16): [string, string][] {
  const entries = Object.entries(specs).filter(([, v]) => v?.length && v.join("").trim());
  const rank = (k: string) => {
    const i = SPEC_ORDER.findIndex((o) => o.toLowerCase() === k.toLowerCase());
    return i < 0 ? SPEC_ORDER.length : i;
  };
  return entries
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .slice(0, max)
    .map(([k, v]) => {
      const val = v.join(", ");
      return [k, val.length > 180 ? `${val.slice(0, 177)}...` : val];
    });
}

/** True if Claude returned enough to build a description. */
export const hasContent = (c?: DescriptionContent | null) => Boolean(c?.headline?.trim() && c.intro?.trim());

/** "MotorSupply Co" with highlight "Supply" -> Motor + red "Supply" + Co, bold italic like the store banner. */
export function wordmark(name: string, highlight: string, accent: string, size = 30, color = "#ffffff"): string {
  const style = `font-family:'Arial Black',Arial,Helvetica,sans-serif;font-weight:900;font-style:italic;font-size:${size}px;line-height:1.1;letter-spacing:-0.5px;color:${color}`;
  const h = cleanText(highlight);
  const i = h ? name.toLowerCase().indexOf(h.toLowerCase()) : -1;
  const inner =
    i < 0
      ? esc(name)
      : `${esc(name.slice(0, i))}<span style="color:${accent}">${esc(name.slice(i, i + h.length))}</span>${esc(name.slice(i + h.length))}`;
  return `<span style="${style}">${inner}</span>`;
}

export function renderAplus(input: AplusInput): string {
  const { content: c, brand: b } = input;
  const hex = (v: string | undefined, d: string) => (/^#[0-9a-f]{6}$/i.test(v || "") ? v! : d);
  const accent = hex(b.accentColor, "#e11d2a");
  const dark = hex(b.darkColor, "#0b0f19");
  const brandName = cleanText(b.brandName) || input.storeName;
  const logo = httpsOnly(b.logoUrl);
  const pics = b.showPhotos ? input.pictures.map(httpsOnly).filter(Boolean) : [];
  const specs = specRows(input.specifics);
  const groups = b.showCompatibility ? groupFitment(input.compatibility) : [];
  const shownGroups = groups.slice(0, 30);
  const notes = b.keepOriginalNotes ? cleanText(originalNotes(input.currentHtml)).slice(0, 3000) : "";
  const pn = (input.specifics["Manufacturer Part Number"] ?? input.specifics["OE/OEM Part Number"] ?? [])[0];
  const highlights = (c.highlights ?? []).map(cleanText).filter(Boolean).slice(0, 8);
  const included = (c.included ?? []).map(cleanText).filter(Boolean).slice(0, 8);
  const badges = (b.badges ?? []).map(cleanText).filter(Boolean).slice(0, 4);
  const caps = (ls = 3) => `text-transform:uppercase;letter-spacing:${ls}px`;

  const h2 = (t: string) =>
    `<h2 style="margin:0 0 14px;font-size:17px;font-weight:900;color:${dark};${caps(1.5)};border-left:5px solid ${accent};padding:2px 0 2px 10px">${esc(t)}</h2>`;
  const section = (inner: string) => `<div style="margin:0 0 26px">${inner}</div>`;
  const tick =
    `<span style="display:inline-block;width:20px;height:20px;line-height:20px;border-radius:50%;background:${accent};color:#ffffff;` +
    `text-align:center;font-size:12px;font-weight:bold;margin-right:8px;vertical-align:middle">&#10003;</span>`;
  const card = (title: string, body: string) =>
    `<div style="flex:1 1 210px;min-width:0;border:1px solid #e5e7eb;border-top:4px solid ${accent};border-radius:4px;padding:12px 14px;background:#ffffff">` +
    `<div style="font-weight:900;color:${dark};margin-bottom:4px;${caps(1)};font-size:13px">${esc(title)}</div>` +
    `<div style="font-size:14px;color:#374151">${multiline(body)}</div></div>`;
  const td = "padding:8px 10px;border:1px solid #e5e7eb";
  const tableHead = (cols: string[]) =>
    `<tr style="background:${dark};color:#ffffff">` +
    cols.map((x) => `<th style="padding:8px 10px;text-align:left;font-size:12px;${caps(1)};border-bottom:3px solid ${accent}">${esc(x)}</th>`).join("") +
    `</tr>`;

  const out: string[] = [APLUS_MARKER];
  out.push(
    `<div style="max-width:980px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;background:#ffffff;border:1px solid #e5e7eb">`,
  );

  // header: dark band with a red diagonal stripe; logo + wordmark + spaced tagline
  out.push(
    `<div style="background-color:${dark};background-image:linear-gradient(115deg,${dark} 0%,${dark} 72%,${accent} 72%,${accent} 75%,#1f2937 75%,#111827 100%);color:#ffffff;padding:20px 24px">` +
      `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px">` +
      (logo ? `<img src="${esc(logo)}" alt="${esc(brandName)}" style="height:64px;width:auto;max-width:180px;display:block;background:#ffffff;border-radius:6px;padding:4px">` : "") +
      `<div style="min-width:0">${wordmark(brandName, b.brandHighlight, accent)}` +
      (b.tagline.trim()
        ? `<div style="margin-top:6px;font-size:11px;font-weight:bold;${caps()};color:#e5e7eb">` +
          `<span style="display:inline-block;width:22px;height:2px;background:${accent};vertical-align:middle;margin-right:8px"></span>${txt(b.tagline)}</div>`
        : "") +
      `</div></div></div>`,
  );

  // trust badges strip
  if (badges.length) {
    out.push(
      `<div style="display:flex;flex-wrap:wrap;background:#f3f4f6;border-bottom:1px solid #e5e7eb">` +
        badges
          .map(
            (t, i) =>
              `<div style="flex:1 1 150px;padding:12px 14px;font-size:12px;font-weight:900;color:${dark};${caps(1)};${i ? "border-left:1px solid #d1d5db" : ""}">${tick}${esc(t)}</div>`,
          )
          .join("") +
        `</div>`,
    );
  }

  out.push(`<div style="padding:22px">`);

  // hero
  out.push(
    `<div style="display:flex;flex-wrap:wrap;gap:22px;margin:0 0 26px;align-items:flex-start">` +
      (pics[0]
        ? `<div style="flex:1 1 300px;min-width:0"><img src="${esc(pics[0])}" alt="${esc(input.title)}" style="width:100%;height:auto;border:1px solid #e5e7eb;border-radius:4px"></div>`
        : "") +
      `<div style="flex:1 1 320px;min-width:0">` +
      `<h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;font-weight:900;color:${dark}">${txt(c.headline)}</h1>` +
      `<p style="margin:0 0 14px">${multiline(c.intro)}</p>` +
      `<div style="display:flex;flex-wrap:wrap;gap:8px">` +
      (pn ? `<span style="background:${dark};color:#ffffff;border-radius:3px;padding:5px 10px;font-size:13px"><b style="color:${accent}">PART #</b> ${txt(pn)}</span>` : "") +
      (input.condition ? `<span style="background:#f3f4f6;border-radius:3px;padding:5px 10px;font-size:13px"><b>CONDITION</b> ${txt(input.condition)}</span>` : "") +
      `</div></div></div>`,
  );

  if (highlights.length) {
    out.push(
      section(
        h2("Why buy this part") +
          `<div style="display:flex;flex-wrap:wrap;gap:10px">` +
          highlights
            .map((h) => `<div style="flex:1 1 260px;min-width:0;background:#f9fafb;border-left:3px solid ${accent};padding:10px 12px">${tick}${esc(h)}</div>`)
            .join("") +
          `</div>`,
      ),
    );
  }

  if (pics.length > 1) {
    out.push(
      section(
        h2("More photos") +
          `<div style="display:flex;flex-wrap:wrap;gap:8px">` +
          pics
            .slice(1, 7)
            .map((p) => `<div style="flex:1 1 140px;max-width:230px"><img src="${esc(p)}" alt="" style="width:100%;height:auto;border:1px solid #e5e7eb;border-radius:3px"></div>`)
            .join("") +
          `</div>`,
      ),
    );
  }

  // specs + fitment side by side
  const specHtml = specs.length
    ? `<div style="flex:1 1 360px;min-width:0">${h2("Specifications")}<table style="width:100%;border-collapse:collapse;font-size:14px">` +
      specs
        .map(
          ([k, v], i) =>
            `<tr style="background:${i % 2 ? "#ffffff" : "#f9fafb"}"><td style="${td};width:42%;color:#6b7280">${txt(k)}</td><td style="${td};font-weight:bold;color:${dark}">${txt(v)}</td></tr>`,
        )
        .join("") +
      `</table></div>`
    : "";
  const fitHtml =
    c.fitment_summary.trim() || shownGroups.length
      ? `<div style="flex:1 1 360px;min-width:0">${h2("Fitment")}` +
        (c.fitment_summary.trim() ? `<p style="margin:0 0 10px">${multiline(c.fitment_summary)}</p>` : "") +
        (shownGroups.length
          ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${tableHead(["Vehicle", "Years"])}` +
            shownGroups
              .map(
                (g, i) =>
                  `<tr style="background:${i % 2 ? "#ffffff" : "#f9fafb"}"><td style="${td};font-weight:bold;color:${dark}">${txt(g.vehicle)}</td><td style="${td}">${esc(g.years)}</td></tr>`,
              )
              .join("") +
            `</table>` +
            (groups.length > shownGroups.length
              ? `<p style="margin:6px 0 0;font-size:13px;color:#6b7280">+ ${groups.length - shownGroups.length} more models - see the compatibility chart on this listing.</p>`
              : c.fitment_summary.trim()
                ? ""
                : `<p style="margin:6px 0 0;font-size:13px;color:#6b7280">Always check the part number and the eBay compatibility chart before buying.</p>`)
          : "") +
        `</div>`
      : "";
  if (specHtml || fitHtml) out.push(`<div style="display:flex;flex-wrap:wrap;gap:22px;margin:0 0 26px">${specHtml}${fitHtml}</div>`);

  if (c.condition_notes.trim()) {
    out.push(section(h2("Condition") + `<div style="background:#fef2f2;border-left:4px solid ${accent};padding:12px 14px">${multiline(c.condition_notes)}</div>`));
  }

  if (included.length || c.install_tips.trim()) {
    out.push(
      section(
        h2("What's included") +
          (included.length ? `<ul style="margin:0 0 10px;padding-left:20px">${included.map((i) => `<li style="margin:2px 0">${esc(i)}</li>`).join("")}</ul>` : "") +
          (c.install_tips.trim() ? `<p style="margin:0;font-size:14px;color:#374151"><b style="color:${accent}">TIP:</b> ${txt(c.install_tips)}</p>` : ""),
      ),
    );
  }

  const policies = [
    ["Shipping", b.shippingText],
    ["Returns", b.returnsText],
    ["Warranty", b.warrantyText],
    ["Questions?", b.contactText],
  ].filter(([, t]) => cleanText(t));
  if (policies.length) {
    out.push(section(`<div style="display:flex;flex-wrap:wrap;gap:12px">${policies.map(([t, body]) => card(t, body)).join("")}</div>`));
  }

  if (notes) {
    out.push(section(h2("Seller notes") + `<div style="font-size:14px;color:#374151">${NOTES_START}${esc(notes).replace(/\n/g, "<br>")}${NOTES_END}</div>`));
  }

  out.push(`</div>`); // body

  // footer: dark band, red rule, spaced "thank you" line + small wordmark
  out.push(
    `<div style="background:${dark};color:#ffffff;padding:16px 24px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px">` +
      `<div style="font-size:12px;font-weight:bold;${caps()}">` +
      `<span style="display:inline-block;width:34px;height:3px;background:${accent};vertical-align:middle;margin-right:10px"></span>` +
      `${txt(b.footerText || `Thank you for shopping with ${brandName}`)}</div>` +
      `<div>${wordmark(brandName, b.brandHighlight, accent, 18)}</div>` +
      `</div>`,
  );
  out.push(`</div>`);
  return out.join("\n");
}
