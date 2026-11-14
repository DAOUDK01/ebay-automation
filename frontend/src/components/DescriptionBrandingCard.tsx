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

        <div className="ml-11 grid max-w-3xl gap-4 sm:grid-cols-2">
          <Field label="Brand name" hint={`Empty = ${fallbackName}`}>
            <input className="input" value={d.brandName} maxLength={80} placeholder={fallbackName} onChange={(e) => onChange("brandName", e.target.value)} />
          </Field>
          <Field label="Accent colour">
            <div className="flex gap-2">
              <input
                type="color"
                className="h-9 w-12 cursor-pointer rounded border border-slate-300"
                value={/^#[0-9a-f]{6}$/i.test(d.accentColor) ? d.accentColor : "#1e3a8a"}
                onChange={(e) => onChange("accentColor", e.target.value)}
              />
              <input className="input" value={d.accentColor} maxLength={7} onChange={(e) => onChange("accentColor", e.target.value)} />
            </div>
          </Field>
          <Field label="Tagline">
            <input className="input" value={d.tagline} maxLength={160} onChange={(e) => onChange("tagline", e.target.value)} />
          </Field>
          <Field label="Logo URL (optional)" hint="https:// image link, e.g. from your eBay store header. Empty = brand name as text.">
            <input className="input" value={d.logoUrl} maxLength={500} placeholder="https://…" onChange={(e) => onChange("logoUrl", e.target.value.trim())} />
          </Field>
        </div>

        <div className="ml-11 grid max-w-3xl gap-4 sm:grid-cols-2">
          {text("shippingText", "Shipping box")}
          {text("returnsText", "Returns box")}
          {text("warrantyText", "Warranty box", "Leave empty to hide.")}
          {text("contactText", "Questions box")}
        </div>
        <p className="ml-11 text-xs text-slate-500">
          eBay doesn&apos;t allow links, emails or phone numbers in descriptions - they are removed automatically.
        </p>

        <div className="ml-11 space-y-3">
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
