/**
 * Branded "A+" listing description. Claude writes the words (DescriptionContent); this file lays them out
 * in the store's branded template (styled after the store banner: dark band, red accent, bold italic
 * wordmark, spaced caps, trust badges). Output is eBay-safe: inline styles only, no scripts, no forms,
 * no off-eBay links, every piece of text HTML-escaped.
 */
import type { StoreSettings } from "../models/Store";
import type { DescriptionContent } from "./claude";
import type { CompatRow, Specifics } from "./ebay/types";
import type { RelatedItem } from "./related";

export const APLUS_MARKER = "<!-- lo-aplus:v1 -->";

/** Fixed for every store: shown in every description and given to Claude so FAQs never contradict it. */
export const RETURN_POLICY = "30-day returns accepted. The buyer pays return shipping.";
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
  /** eBay user id - used for store / feedback / contact links */
  sellerId?: string;
  price?: number;
  currency?: string;
  /** other items from the store for "You may also like" */
  related?: RelatedItem[];
  /** ribbon on the main photo: "Genuine OEM" for genuine parts, "Brand New" for new aftermarket parts */
  ribbon?: string;
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

/** Links back into the seller's own eBay pages (the only links eBay allows in descriptions). */
export function storeLinks(sellerId: string, storeUrl: string) {
  const id = encodeURIComponent(sellerId || "");
  const store = /^https:\/\/(www\.)?ebay\.[a-z.]+\//i.test(storeUrl || "") ? storeUrl : `https://www.ebay.com/sch/i.html?_ssn=${id}`;
  return {
    home: store,
    all: `https://www.ebay.com/sch/i.html?_ssn=${id}`,
    feedback: `https://www.ebay.com/fdbk/feedback_profile/${id}`,
    contact: `https://www.ebay.com/cnt/intermediatedFAQ?requested=${id}`,
    item: (itemId: string) => `https://www.ebay.com/itm/${encodeURIComponent(itemId)}`,
  };
}

const money = (n: number | undefined, cur = "USD") =>
  typeof n === "number" && n > 0 ? `${cur === "USD" ? "$" : `${cur} `}${n.toFixed(2)}` : "";

export function renderAplus(input: AplusInput): string {
  const { content: c, brand: b } = input;
  const hex = (v: string | undefined, d: string) => (/^#[0-9a-f]{6}$/i.test(v || "") ? v! : d);
  const R = hex(b.accentColor, "#e11d2a"); // brand red
  const D = hex(b.darkColor, "#0b0f19"); // brand dark
  const brandName = cleanText(b.brandName) || input.storeName;
  const logo = httpsOnly(b.logoUrl);
  const banner = httpsOnly(b.bannerUrl ?? "");
  const links = storeLinks(input.sellerId || input.storeName, b.storeUrl ?? "");
  const pics = b.showPhotos ? input.pictures.map(httpsOnly).filter(Boolean) : [];
  const specs = specRows(input.specifics);
  const groups = b.showCompatibility ? groupFitment(input.compatibility) : [];
  const shownGroups = groups.slice(0, 24);
  const notes = b.keepOriginalNotes ? cleanText(originalNotes(input.currentHtml)).slice(0, 3000) : "";
  const spec1 = (...names: string[]) => names.map((n) => input.specifics[n]?.join(", ")).find(Boolean) ?? "";
  const pn = spec1("Manufacturer Part Number", "OE/OEM Part Number");
  const highlights = (c.highlights ?? []).map(cleanText).filter(Boolean).slice(0, 6);
  const included = (c.included ?? []).map(cleanText).filter(Boolean).slice(0, 8);
  const faqs = b.showFaq === false ? [] : (c.faqs ?? []).map((f) => ({ q: cleanText(f.q), a: cleanText(f.a) })).filter((f) => f.q && f.a).slice(0, 5);
  const badges = (b.badges ?? []).map(cleanText).filter(Boolean).slice(0, 4);
  const related = b.showRelated === false ? [] : (input.related ?? []).filter((r) => httpsOnly(r.imageUrl)).slice(0, b.relatedCount || 4);

  // ---- style atoms
  const F = "font-family:Arial,Helvetica,sans-serif";
  const caps = (ls = 2) => `text-transform:uppercase;letter-spacing:${ls}px`;
  const texture = `background-color:${D};background-image:repeating-linear-gradient(135deg,rgba(255,255,255,0.035) 0px,rgba(255,255,255,0.035) 2px,transparent 2px,transparent 7px)`;
  const a = (href: string, inner: string, style: string) => `<a href="${esc(href)}" target="_blank" style="text-decoration:none;${style}">${inner}</a>`;
  const btn = (href: string, label: string, kind: "red" | "dark" | "ghost" = "red") =>
    a(
      href,
      esc(label),
      `display:inline-block;padding:11px 20px;font-size:13px;font-weight:900;${caps(1.5)};border-radius:3px;` +
        (kind === "red"
          ? `background:${R};color:#ffffff;border:2px solid ${R}`
          : kind === "dark"
            ? `background:${D};color:#ffffff;border:2px solid ${D}`
            : `background:transparent;color:#ffffff;border:2px solid rgba(255,255,255,0.6)`),
    );
  const icon = (glyph: string, size = 38, bg = R) =>
    `<span style="display:inline-block;width:${size}px;height:${size}px;line-height:${size}px;border-radius:50%;background:${bg};color:#ffffff;text-align:center;font-size:${Math.round(size * 0.45)}px;font-weight:900;flex:0 0 auto">${glyph}</span>`;
  const title = (kicker: string, text: string, onDark = false) =>
    `<div style="text-align:center;margin:0 0 22px">` +
    `<div style="font-size:12px;font-weight:bold;color:${R};${caps(4)}">${esc(kicker)}</div>` +
    `<h2 style="margin:6px 0 0;font-size:26px;line-height:1.2;font-weight:900;${caps(1)};color:${onDark ? "#ffffff" : D}">${esc(text)}</h2>` +
    `<div style="margin:10px auto 0;width:70px;height:4px;background:${R}"></div></div>`;
  const wrap = (inner: string, bg = "#ffffff", pad = "34px 24px") => `<div style="background:${bg};padding:${pad}">${inner}</div>`;
  const td = "padding:9px 12px;border-bottom:1px solid #e5e7eb;font-size:14px";

  const out: string[] = [APLUS_MARKER];
  out.push(`<div style="max-width:1000px;margin:0 auto;${F};font-size:15px;line-height:1.6;color:#1f2937;background:#ffffff;border:1px solid #e5e7eb">`);

  // ---- 1. top menu bar
  const nav = [
    ["Store home", links.home],
    ["All items", links.all],
    ["Feedback", links.feedback],
    ["Contact us", links.contact],
  ];
  out.push(
    `<div style="${texture};padding:12px 20px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;border-bottom:3px solid ${R}">` +
      `<div style="display:flex;align-items:center;gap:10px">` +
      (logo ? `<img src="${esc(logo)}" alt="" style="height:40px;width:auto;background:#ffffff;border-radius:50%;padding:2px">` : "") +
      a(links.home, wordmark(brandName, b.brandHighlight, R, 22), "") +
      `</div>` +
      `<div style="display:flex;flex-wrap:wrap;gap:4px">` +
      nav.map(([l, h]) => a(h, esc(l), `color:#ffffff;font-size:12px;font-weight:bold;${caps(1.5)};padding:8px 12px;border-radius:3px`)).join("") +
      `</div></div>`,
  );

  // ---- 2. banner (their own image) or a built hero in the banner style
  if (banner) {
    out.push(a(links.home, `<img src="${esc(banner)}" alt="${esc(brandName)}" style="display:block;width:100%;height:auto">`, "display:block"));
  } else {
    out.push(
      `<div style="background-color:${D};background-image:linear-gradient(115deg,${D} 0%,${D} 58%,${R} 58%,${R} 61%,#1f2937 61%,#1f2937 66%,${R} 66%,${R} 67%,#111827 67%,#0b0f19 100%);padding:38px 28px;color:#ffffff">` +
        `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:18px">` +
        (logo ? `<img src="${esc(logo)}" alt="${esc(brandName)}" style="height:96px;width:auto;background:#ffffff;border-radius:50%;padding:4px">` : "") +
        `<div>${wordmark(brandName, b.brandHighlight, R, 44)}` +
        (b.tagline.trim()
          ? `<div style="margin-top:10px;font-size:13px;font-weight:bold;${caps(5)};color:#e5e7eb"><span style="display:inline-block;width:40px;height:2px;background:${R};vertical-align:middle;margin-right:12px"></span>${txt(b.tagline)}</div>`
          : "") +
        `<div style="margin-top:18px">${btn(links.all, "Shop all parts")} ${btn(links.contact, "Ask a question", "ghost")}</div>` +
        `</div></div></div>`,
    );
  }

  // ---- 3. trust badges
  if (badges.length) {
    const glyphs = ["&#10003;", "&#10148;", "&#9733;", "&#9673;"];
    out.push(
      `<div style="display:flex;flex-wrap:wrap;background:#f3f4f6;border-bottom:1px solid #e5e7eb">` +
        badges
          .map(
            (t, i) =>
              `<div style="flex:1 1 200px;display:flex;align-items:center;gap:12px;padding:16px 18px;${i ? "border-left:1px solid #e5e7eb" : ""}">` +
              icon(glyphs[i % glyphs.length], 40) +
              `<div style="font-size:13px;font-weight:900;color:${D};${caps(1)};line-height:1.25">${esc(t)}</div></div>`,
          )
          .join("") +
        `</div>`,
    );
  }

  // ---- 4. product showcase
  const facts = [
    ["Part number", pn],
    ["Condition", input.condition],
    ["Brand", spec1("Brand")],
    ["Position", spec1("Placement on Vehicle")],
  ].filter(([, v]) => v);
  const price = money(input.price, input.currency);
  out.push(
    wrap(
      `<div style="display:flex;flex-wrap:wrap;gap:28px;align-items:flex-start">` +
        (pics[0]
          ? `<div style="flex:1 1 360px;min-width:0">` +
            `<div style="position:relative;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;background:#ffffff">` +
            `<div style="position:absolute;top:14px;left:-6px;background:${R};color:#ffffff;font-size:12px;font-weight:900;${caps(1.5)};padding:6px 14px 6px 16px;box-shadow:0 2px 6px rgba(0,0,0,0.25)">${esc(input.ribbon ?? "Genuine OEM")}</div>` +
            `<img src="${esc(pics[0])}" alt="${esc(input.title)}" style="display:block;width:100%;height:auto"></div>` +
            (pics.length > 1
              ? `<div style="display:flex;gap:8px;margin-top:8px">` +
                pics
                  .slice(1, 5)
                  .map((p) => `<div style="flex:1 1 0;min-width:0;border:1px solid #e5e7eb;border-radius:4px;overflow:hidden"><img src="${esc(p)}" alt="" style="display:block;width:100%;height:auto"></div>`)
                  .join("") +
                `</div>`
              : "") +
            `</div>`
          : "") +
        `<div style="flex:1 1 360px;min-width:0">` +
        `<div style="display:inline-block;background:${D};color:#ffffff;font-size:11px;font-weight:900;${caps(2)};padding:5px 10px;border-left:4px solid ${R}">${esc(brandName)} &middot; Auto parts</div>` +
        `<h1 style="margin:12px 0 12px;font-size:30px;line-height:1.15;font-weight:900;color:${D}">${txt(c.headline)}</h1>` +
        (price ? `<div style="font-size:28px;font-weight:900;color:${R};margin:0 0 10px">${esc(price)}</div>` : "") +
        `<p style="margin:0 0 18px;font-size:16px;color:#374151">${multiline(c.intro)}</p>` +
        (facts.length
          ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px">` +
            facts
              .map(
                ([k, v]) =>
                  `<div style="flex:1 1 140px;min-width:0;background:#f9fafb;border:1px solid #e5e7eb;border-top:3px solid ${R};border-radius:3px;padding:9px 12px">` +
                  `<div style="font-size:11px;color:#6b7280;${caps(1)}">${esc(k)}</div><div style="font-weight:900;color:${D};word-break:break-word">${txt(v)}</div></div>`,
              )
              .join("") +
            `</div>`
          : "") +
        `<div style="${texture};color:#ffffff;border-radius:4px;padding:16px 18px;border-left:5px solid ${R}">` +
        `<div style="font-weight:900;${caps(1)};font-size:14px;margin-bottom:4px">&#10003; Fitment check</div>` +
        `<div style="font-size:14px;color:#e5e7eb;margin-bottom:12px">Not sure it fits? Send us your VIN before you buy and we will confirm it for you.</div>` +
        btn(links.contact, "Check my vehicle") +
        `</div></div></div>`,
    ),
  );

  // ---- 5. why buy (numbered cards)
  if (highlights.length) {
    out.push(
      wrap(
        title("The details", "Why buy this part") +
          `<div style="display:flex;flex-wrap:wrap;gap:14px">` +
          highlights
            .map(
              (h, i) =>
                `<div style="flex:1 1 280px;min-width:0;display:flex;gap:14px;align-items:flex-start;background:#ffffff;border:1px solid #e5e7eb;border-radius:4px;padding:16px;box-shadow:0 2px 0 ${R}">` +
                `<div style="flex:0 0 auto;font-family:'Arial Black',Arial,sans-serif;font-size:28px;font-weight:900;font-style:italic;color:${R};line-height:1">${String(i + 1).padStart(2, "0")}</div>` +
                `<div style="font-size:15px;color:${D};font-weight:bold">${esc(h)}</div></div>`,
            )
            .join("") +
          `</div>`,
        "#f9fafb",
      ),
    );
  }

  // ---- 6. specs + fitment on a dark band
  const specHtml = specs.length
    ? `<div style="flex:1 1 400px;min-width:0;background:#ffffff;border-radius:4px;overflow:hidden">` +
      `<div style="background:${R};color:#ffffff;font-weight:900;${caps(1.5)};padding:11px 14px;font-size:14px">Specifications</div>` +
      `<table style="width:100%;border-collapse:collapse">` +
      specs.map(([k, v]) => `<tr><td style="${td};width:42%;color:#6b7280">${txt(k)}</td><td style="${td};font-weight:bold;color:${D}">${txt(v)}</td></tr>`).join("") +
      `</table></div>`
    : "";
  const fitHtml =
    c.fitment_summary.trim() || shownGroups.length
      ? `<div style="flex:1 1 400px;min-width:0;background:#ffffff;border-radius:4px;overflow:hidden">` +
        `<div style="background:${R};color:#ffffff;font-weight:900;${caps(1.5)};padding:11px 14px;font-size:14px">Vehicle fitment</div>` +
        (c.fitment_summary.trim() ? `<p style="margin:0;padding:12px 14px;font-size:14px;color:#374151;border-bottom:1px solid #e5e7eb">${multiline(c.fitment_summary)}</p>` : "") +
        (shownGroups.length
          ? `<table style="width:100%;border-collapse:collapse"><tr style="background:#f3f4f6"><th style="${td};text-align:left;font-size:12px;${caps(1)};color:#6b7280">Vehicle</th><th style="${td};text-align:left;font-size:12px;${caps(1)};color:#6b7280">Years</th></tr>` +
            shownGroups.map((g) => `<tr><td style="${td};font-weight:bold;color:${D}">${txt(g.vehicle)}</td><td style="${td}">${esc(g.years)}</td></tr>`).join("") +
            `</table>` +
            (groups.length > shownGroups.length
              ? `<p style="margin:0;padding:10px 14px;font-size:13px;color:#6b7280">+ ${groups.length - shownGroups.length} more models - see the compatibility chart on this listing.</p>`
              : "")
          : "") +
        `</div>`
      : "";
  if (specHtml || fitHtml) {
    out.push(wrap(title("Know before you buy", "Specs & fitment", true) + `<div style="display:flex;flex-wrap:wrap;gap:18px">${specHtml}${fitHtml}</div>`, "", `34px 24px;${texture}`));
  }

  // ---- 7. condition + included
  const condBox = c.condition_notes.trim()
    ? `<div style="flex:1 1 380px;min-width:0;border:1px solid #e5e7eb;border-radius:4px;padding:20px;border-top:4px solid ${R}">` +
      `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">${icon("&#9881;", 34, D)}<div style="font-weight:900;font-size:17px;color:${D};${caps(1)}">Condition</div></div>` +
      `<div style="font-size:15px;color:#374151">${multiline(c.condition_notes)}</div></div>`
    : "";
  const inclBox =
    included.length || c.install_tips.trim()
      ? `<div style="flex:1 1 380px;min-width:0;border:1px solid #e5e7eb;border-radius:4px;padding:20px;border-top:4px solid ${R}">` +
        `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">${icon("&#9638;", 34, D)}<div style="font-weight:900;font-size:17px;color:${D};${caps(1)}">What's in the box</div></div>` +
        (included.length
          ? included.map((i) => `<div style="padding:5px 0;border-bottom:1px dashed #e5e7eb;font-size:15px"><span style="color:${R};font-weight:900;margin-right:8px">&#10003;</span>${esc(i)}</div>`).join("")
          : "") +
        (c.install_tips.trim()
          ? `<div style="margin-top:12px;background:#fef2f2;border-left:4px solid ${R};padding:10px 12px;font-size:14px"><b style="color:${R}">PRO TIP:</b> ${txt(c.install_tips)}</div>`
          : "") +
        `</div>`
      : "";
  if (condBox || inclBox) out.push(wrap(`<div style="display:flex;flex-wrap:wrap;gap:18px">${condBox}${inclBox}</div>`));

  // ---- 8. how your order works
  const steps = [
    ["&#10003;", "You order", "Buy it now - we get your order straight away."],
    ["&#9881;", "We inspect & pack", "Every part is checked and packed to arrive safely."],
    ["&#10148;", "Fast dispatch", cleanText(b.shippingText) || "Shipped within the handling time with tracking."],
    ["&#9733;", "Enjoy the ride", "Fit your part and get back on the road."],
  ];
  out.push(
    wrap(
      title("Simple & safe", "How your order works") +
        `<div style="display:flex;flex-wrap:wrap;gap:14px">` +
        steps
          .map(
            ([g, h, t], i) =>
              `<div style="flex:1 1 200px;min-width:0;text-align:center;padding:10px">` +
              `<div style="position:relative;display:inline-block">${icon(g, 64, i % 2 ? D : R)}` +
              `<span style="position:absolute;top:-4px;right:-6px;background:#ffffff;color:${D};border:2px solid ${D};border-radius:50%;width:24px;height:24px;line-height:20px;font-size:12px;font-weight:900">${i + 1}</span></div>` +
              `<div style="margin-top:12px;font-weight:900;color:${D};${caps(1)};font-size:15px">${esc(h)}</div>` +
              `<div style="margin-top:4px;font-size:14px;color:#4b5563">${esc(t)}</div></div>`,
          )
          .join("") +
        `</div>`,
      "#f9fafb",
    ),
  );

  // ---- 9. FAQ
  if (faqs.length) {
    out.push(
      wrap(
        title("Questions", "Frequently asked") +
          faqs
            .map(
              (f) =>
                `<div style="border:1px solid #e5e7eb;border-left:5px solid ${R};border-radius:3px;margin:0 0 10px;padding:14px 16px">` +
                `<div style="font-weight:900;color:${D};font-size:15px"><span style="color:${R};margin-right:8px">Q.</span>${esc(f.q)}</div>` +
                `<div style="margin-top:6px;font-size:14px;color:#374151"><span style="color:${D};font-weight:900;margin-right:8px">A.</span>${esc(f.a)}</div></div>`,
            )
            .join(""),
      ),
    );
  }

  // ---- 10. policies
  const policies = [
    ["&#10148;", "Shipping", b.shippingText],
    ["&#8634;", "Returns", RETURN_POLICY],
    ["&#9733;", "Warranty", b.warrantyText],
    ["?", "Questions", b.contactText],
  ].filter(([, , t]) => cleanText(t));
  if (policies.length) {
    out.push(
      wrap(
        `<div style="display:flex;flex-wrap:wrap;gap:14px">` +
          policies
            .map(
              ([g, h, t]) =>
                `<div style="flex:1 1 210px;min-width:0;background:#ffffff;border-radius:4px;padding:18px;text-align:center;border-bottom:4px solid ${R}">` +
                icon(g, 46) +
                `<div style="margin-top:10px;font-weight:900;color:${D};${caps(1)}">${esc(h)}</div>` +
                `<div style="margin-top:4px;font-size:14px;color:#4b5563">${multiline(t)}</div></div>`,
            )
            .join("") +
          `</div>`,
        "#f3f4f6",
      ),
    );
  }

  // ---- 11. you may also like
  if (related.length) {
    out.push(
      wrap(
        title(`More from ${brandName}`, "You may also like") +
          `<div style="display:flex;flex-wrap:wrap;gap:14px">` +
          related
            .map((r) =>
              a(
                links.item(r.itemId),
                `<div style="height:170px;background:#ffffff;display:flex;align-items:center;justify-content:center;overflow:hidden;border-bottom:3px solid ${R}">` +
                  `<img src="${esc(r.imageUrl)}" alt="" style="max-width:100%;max-height:170px;display:block"></div>` +
                  `<div style="padding:12px">` +
                  `<div style="font-size:13px;line-height:1.35;color:${D};font-weight:bold;height:53px;overflow:hidden">${txt(r.title)}</div>` +
                  `<div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between;gap:6px">` +
                  `<span style="font-size:18px;font-weight:900;color:${R}">${esc(money(r.price, input.currency))}</span>` +
                  `<span style="background:${D};color:#ffffff;font-size:11px;font-weight:900;${caps(1)};padding:6px 10px;border-radius:3px">View</span></div></div>`,
                `flex:1 1 200px;min-width:0;max-width:240px;display:block;background:#ffffff;border:1px solid #e5e7eb;border-radius:4px;overflow:hidden;color:${D}`,
              ),
            )
            .join("") +
          `</div>` +
          `<div style="text-align:center;margin-top:22px">${btn(links.all, `Shop all ${brandName} parts`, "dark")}</div>`,
      ),
    );
  }

  // ---- 12. seller notes
  if (notes) {
    out.push(
      wrap(
        `<div style="border:1px dashed #d1d5db;border-radius:4px;padding:16px">` +
          `<div style="font-weight:900;color:${D};${caps(1)};margin-bottom:6px">Seller notes</div>` +
          `<div style="font-size:14px;color:#374151">${NOTES_START}${esc(notes).replace(/\n/g, "<br>")}${NOTES_END}</div></div>`,
        "#ffffff",
        "0 24px 30px",
      ),
    );
  }

  // ---- 13. footer
  out.push(
    `<div style="${texture};color:#d1d5db;padding:30px 24px 0">` +
      `<div style="display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between">` +
      `<div style="flex:1 1 260px;min-width:0">${wordmark(brandName, b.brandHighlight, R, 26)}` +
      (b.tagline.trim() ? `<div style="margin-top:8px;font-size:12px;${caps(3)};color:#9ca3af">${txt(b.tagline)}</div>` : "") +
      `<div style="margin-top:14px">${btn(links.home, "Visit our store")}</div></div>` +
      `<div style="flex:0 1 180px;min-width:0"><div style="color:#ffffff;font-weight:900;${caps(1.5)};margin-bottom:8px;border-bottom:2px solid ${R};padding-bottom:6px">Quick links</div>` +
      nav.map(([l, h]) => `<div style="padding:3px 0">${a(h, `&rsaquo; ${esc(l)}`, "color:#d1d5db;font-size:14px")}</div>`).join("") +
      `</div>` +
      `<div style="flex:0 1 220px;min-width:0"><div style="color:#ffffff;font-weight:900;${caps(1.5)};margin-bottom:8px;border-bottom:2px solid ${R};padding-bottom:6px">Why ${esc(brandName)}</div>` +
      (badges.length ? badges : ["Genuine OEM parts"]).map((t) => `<div style="padding:3px 0;font-size:14px"><span style="color:${R};font-weight:900">&#10003;</span> ${esc(t)}</div>`).join("") +
      `</div></div>` +
      `<div style="margin-top:26px;background:${R};margin-left:-24px;margin-right:-24px;padding:12px 24px;text-align:center;color:#ffffff;font-size:13px;font-weight:900;${caps(4)}">` +
      `${txt(b.footerText || `Thank you for shopping with ${brandName}`)}</div>` +
      `</div>`,
  );

  out.push(`</div>`);
  return out.join("\n");
}
