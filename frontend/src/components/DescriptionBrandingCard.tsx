"use client";
import { Eye } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { DescriptionBrand } from "@/lib/types";
import { toast } from "./toast";
import { Button, Card, Toggle } from "./ui";
import { DescriptionFrame } from "./listing/DescriptionFrame";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** The store's banner look: black + red, "Motor<red>Supply</red> Co", spaced tagline, four trust badges. */
const MOTORSUPPLY: Partial<DescriptionBrand> = {
  brandName: "MotorSupply Co",
  brandHighlight: "Supply",
  tagline: "Driving auto parts to you",
  accentColor: "#e11d2a",
  darkColor: "#0b0f19",
  badges: ["Quality parts", "Fast shipping", "Wide selection", "Global delivery"],
  footerText: "Thank you for your business.",
};

function Color({ label, hint, value, fallback, onChange }: { label: string; hint?: string; value: string; fallback: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input
          type="color"
          className="h-9 w-12 cursor-pointer rounded border border-slate-300"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : fallback}
          onChange={(e) => onChange(e.target.value)}
        />
        <input className="input" value={value} maxLength={7} placeholder={fallback} onChange={(e) => onChange(e.target.value)} />
      </div>
    </Field>
  );
}

/** Settings > Branded A+ description: brand, colours, policy boxes and a live sample preview. */
export function DescriptionBrandingCard({
  storeId,
  value: d,
  fallbackName,
  onChange,
}: {
  storeId: string;
  value: DescriptionBrand;
  fallbackName: string;
  onChange: (key: keyof DescriptionBrand, v: unknown) => void;
}) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);

  async function preview() {
    setLoading(true);
    try {
      const r = await api<{ html: string }>(`/stores/${storeId}/description-preview`, { body: d });
      setHtml(r.html);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  const text = (key: keyof DescriptionBrand, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <textarea className="input min-h-[64px]" value={d[key] as string} maxLength={500} onChange={(e) => onChange(key, e.target.value)} />
    </Field>
  );

  return (
    <Card title="Branded A+ description">
      <div className="space-y-4">
        <Toggle
          checked={d.enabled}
          onChange={(v) => onChange("enabled", v)}
          label={<b>Write a branded A+ description for every listing Claude optimizes</b>}
        />
        <p className="ml-11 -mt-2 text-xs text-slate-500">
          Claude writes the text (headline, intro, highlights, fitment, condition, what&apos;s included). Your branding, photos, specs table,
          compatibility table and policy boxes are added around it. The new description shows on the review card before it goes to eBay.
        </p>

        <div className="ml-11">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              for (const [k, v] of Object.entries(MOTORSUPPLY)) onChange(k as keyof DescriptionBrand, v);
              toast.info("MotorSupply Co style applied - save settings to keep it");
            }}
          >
            <span className="mr-1 inline-block h-3 w-3 rounded-sm bg-[#e11d2a]" />
            <span className="mr-1 inline-block h-3 w-3 rounded-sm bg-[#0b0f19]" /> Use MotorSupply Co style
          </Button>
        </div>

        <div className="ml-11 grid max-w-3xl gap-4 sm:grid-cols-2">
          <Field label="Brand name" hint={`Empty = ${fallbackName}`}>
            <input className="input" value={d.brandName} maxLength={80} placeholder={fallbackName} onChange={(e) => onChange("brandName", e.target.value)} />
          </Field>
          <Field label="Highlighted word" hint='Shown in the accent colour, e.g. "Supply" in MotorSupply Co.'>
            <input className="input" value={d.brandHighlight ?? ""} maxLength={40} onChange={(e) => onChange("brandHighlight", e.target.value)} />
          </Field>
          <Color label="Accent colour" value={d.accentColor} fallback="#e11d2a" onChange={(v) => onChange("accentColor", v)} />
          <Color label="Dark colour" hint="Header, footer and table headings." value={d.darkColor ?? ""} fallback="#0b0f19" onChange={(v) => onChange("darkColor", v)} />
          <Field label="Tagline">
            <input className="input" value={d.tagline} maxLength={160} onChange={(e) => onChange("tagline", e.target.value)} />
          </Field>
          <Field label="Footer line">
            <input className="input" value={d.footerText ?? ""} maxLength={120} onChange={(e) => onChange("footerText", e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Logo URL (optional)" hint="https:// link to your logo image. On eBay: open your store, right-click the logo → Copy image address. Empty = brand name only.">
              <input className="input" value={d.logoUrl} maxLength={500} placeholder="https://i.ebayimg.com/…" onChange={(e) => onChange("logoUrl", e.target.value.trim())} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field
              label="Store banner image URL (recommended)"
              hint="Your eBay store banner: open your store, right-click the big banner → Copy image address. Shown full width at the top. Empty = a built-in banner in your colours."
            >
              <input className="input" value={d.bannerUrl ?? ""} maxLength={500} placeholder="https://i.ebayimg.com/…" onChange={(e) => onChange("bannerUrl", e.target.value.trim())} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="eBay store link (optional)" hint="e.g. https://www.ebay.com/str/yourstore - used by the menu buttons. Empty = your 'all items' page.">
              <input className="input" value={d.storeUrl ?? ""} maxLength={300} placeholder="https://www.ebay.com/str/…" onChange={(e) => onChange("storeUrl", e.target.value.trim())} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Trust badges (up to 4)" hint="Shown in a strip under the header. Leave a box empty to hide it.">
              <div className="grid gap-2 sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <input
                    key={i}
                    className="input"
                    maxLength={40}
                    value={d.badges?.[i] ?? ""}
                    onChange={(e) => {
                      const next = [0, 1, 2, 3].map((j) => (j === i ? e.target.value : d.badges?.[j] ?? ""));
                      onChange("badges", next);
                    }}
                  />
                ))}
              </div>
            </Field>
          </div>
        </div>

        <div className="ml-11 grid max-w-3xl gap-4 sm:grid-cols-2">
          {text("shippingText", "Shipping box")}
          <Field label="Returns box" hint="Fixed for every store and every listing.">
            <div className="input min-h-[64px] cursor-not-allowed bg-slate-50 text-slate-600">30-day returns accepted. The buyer pays return shipping.</div>
          </Field>
          {text("warrantyText", "Warranty box", "Leave empty to hide.")}
          {text("contactText", "Questions box")}
        </div>
        <p className="ml-11 text-xs text-slate-500">
          eBay doesn&apos;t allow links, emails or phone numbers in descriptions - they are removed automatically.
        </p>

        <div className="ml-11 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Toggle
              checked={d.showRelated ?? true}
              onChange={(v) => onChange("showRelated", v)}
              label='"You may also like" - show other items from your store (same vehicle first)'
            />
            <select
              className="input w-auto py-1"
              value={d.relatedCount ?? 4}
              disabled={d.showRelated === false}
              onChange={(e) => onChange("relatedCount", Number(e.target.value))}
            >
              {[2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} items
                </option>
              ))}
            </select>
          </div>
          <Toggle checked={d.showFaq ?? true} onChange={(v) => onChange("showFaq", v)} label="Show a FAQ section (Claude writes 3-4 buyer questions per part)" />
          <Toggle checked={d.showPhotos} onChange={(v) => onChange("showPhotos", v)} label="Show the listing's photos in the description" />
          <Toggle checked={d.showCompatibility} onChange={(v) => onChange("showCompatibility", v)} label="Show a fitment table (vehicles grouped by model with years)" />
          <Toggle
            checked={d.keepOriginalNotes}
            onChange={(v) => onChange("keepOriginalNotes", v)}
            label='Keep my current description text in a "Seller notes" section'
          />
        </div>

        <div className="ml-11">
          <Button variant="secondary" size="sm" loading={loading} onClick={preview}>
            <Eye className="h-3.5 w-3.5" /> {html ? "Refresh preview" : "Preview with a sample listing"}
          </Button>
          {html && (
            <div className="mt-3">
              <DescriptionFrame html={html} />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
