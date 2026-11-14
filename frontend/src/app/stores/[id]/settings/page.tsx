"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "@/components/StoreContext";
import { toast } from "@/components/toast";
import { Alert, Button, Card, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import type { StoreSettings } from "@/lib/types";

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best quality)", inp: 4, out: 20 },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (about half the cost)", inp: 2, out: 10 },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest, lower quality)", inp: 0.1, out: 0.5 },
];

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Num({ value, onChange, step = 1, min = 0 }: { value: number; onChange: (n: number) => void; step?: number; min?: number }) {
  return <input className="input" type="number" step={step} min={min} value={value} onChange={(e) => onChange(Number(e.target.value))} />;
}

export default function SettingsPage() {
  const { data, mutate } = useStore();
  const router = useRouter();
  const store = data.store;
  const [s, setS] = useState<StoreSettings>(store.settings);
  const [name, setName] = useState(store.name);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) {
      setS(store.settings);
      setName(store.name);
    }
  }, [store.settings, store.name, dirty]);

  /** immutable deep update: up("modules.pricing.maxChangePct", 5) */
  function up(path: string, value: unknown) {
    setDirty(true);
    setS((prev) => {
      const next: any = structuredClone(prev);
      const keys = path.split(".");
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k];
      o[keys[keys.length - 1]] = value;
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await api(`/stores/${store.id}`, { method: "PATCH", body: { name, settings: s } });
      toast.success("Settings saved");
      setDirty(false);
      mutate();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${store.name}? This deletes its listings, batches and history from this app (nothing on eBay changes).`)) return;
    try {
      await api(`/stores/${store.id}`, { method: "DELETE" });
      toast.success("Store disconnected");
      router.replace("/stores");
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-6 pb-24">
      <Card title="General">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Store name">
            <input className="input" value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} />
          </Field>
          <Field
            label="Mode"
            hint={s.mode === "auto" ? "Changes go live at the end of every batch." : "Every batch waits for your approval."}
          >
            <select className="input" value={s.mode} onChange={(e) => up("mode", e.target.value)}>
              <option value="review">Review (approve before pushing)</option>
              <option value="auto">Auto (push automatically)</option>
            </select>
          </Field>
          <Field label="Your eBay username (excluded from competitors)">
            <input className="input" value={s.excludeSeller} onChange={(e) => up("excludeSeller", e.target.value)} />
          </Field>
        </div>
        {s.mode === "auto" && (
          <div className="mt-4">
            <Alert kind="warning">Auto mode pushes changes without review. Run a few batches in review mode first.</Alert>
          </div>
        )}
      </Card>

      <Card title="Schedule & pacing">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Listings per batch">
            <Num value={s.batchSize} min={1} onChange={(v) => up("batchSize", v)} />
          </Field>
          <Field label="Gap between batches (min)">
            <Num value={s.gapBetweenBatchesMin} min={1} onChange={(v) => up("gapBetweenBatchesMin", v)} />
          </Field>
          <Field label="Gap between listings (sec)">
            <Num value={s.gapBetweenListingsSec} onChange={(v) => up("gapBetweenListingsSec", v)} />
          </Field>
          <Field label="Gap between eBay updates (sec)">
            <Num value={s.gapBetweenPushesSec} onChange={(v) => up("gapBetweenPushesSec", v)} />
          </Field>
          <Field label="Cooldown (days)" hint="Don't touch the same listing again within this many days.">
            <Num value={s.cooldownDays} min={1} onChange={(v) => up("cooldownDays", v)} />
          </Field>
          <Field label="Re-sync listings every (hours)">
            <Num value={s.resyncHours} min={1} onChange={(v) => up("resyncHours", v)} />
          </Field>
          <Field label="Competitors to compare">
            <Num value={s.competitorCount} min={3} onChange={(v) => up("competitorCount", v)} />
          </Field>
        </div>
        <div className="mt-6 grid items-end gap-4 md:grid-cols-4">
          <Toggle checked={s.activeHours.enabled} onChange={(v) => up("activeHours.enabled", v)} label="Only work during active hours" />
          <Field label="Start (HH:MM)">
            <input className="input" value={s.activeHours.start} disabled={!s.activeHours.enabled} onChange={(e) => up("activeHours.start", e.target.value)} />
          </Field>
          <Field label="End (HH:MM)">
            <input className="input" value={s.activeHours.end} disabled={!s.activeHours.enabled} onChange={(e) => up("activeHours.end", e.target.value)} />
          </Field>
          <Field label="Timezone">
            <input
              className="input"
              value={s.activeHours.timezone}
              disabled={!s.activeHours.enabled}
              onChange={(e) => up("activeHours.timezone", e.target.value)}
              placeholder="America/New_York"
            />
          </Field>
        </div>
      </Card>

      <Card title="Claude">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Model">
            <select
              className="input"
              value={s.claude.model}
              onChange={(e) => {
                const m = MODELS.find((x) => x.id === e.target.value);
                up("claude.model", e.target.value);
                if (m) {
                  up("claude.inputPricePerMtok", m.inp);
                  up("claude.outputPricePerMtok", m.out);
                }
              }}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!MODELS.some((m) => m.id === s.claude.model) && <option value={s.claude.model}>{s.claude.model}</option>}
            </select>
          </Field>
          <Field label="Effort" hint="Higher = more careful, more expensive.">
            <select className="input" value={s.claude.effort} onChange={(e) => up("claude.effort", e.target.value)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>
          <Field label="Monthly budget (USD)" hint="The runner pauses when reached.">
            <Num value={s.claude.monthlyBudgetUsd} step={5} onChange={(v) => up("claude.monthlyBudgetUsd", v)} />
          </Field>
          <Field label="Price per 1M tokens (in / out)">
            <div className="flex gap-2">
              <Num value={s.claude.inputPricePerMtok} step={0.1} onChange={(v) => up("claude.inputPricePerMtok", v)} />
              <Num value={s.claude.outputPricePerMtok} step={0.1} onChange={(v) => up("claude.outputPricePerMtok", v)} />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="What the optimizer may change">
        <div className="space-y-6">
          <div>
            <Toggle checked={s.modules.title.enabled} onChange={(v) => up("modules.title.enabled", v)} label={<b>Titles</b>} />
            <p className="ml-11 text-xs text-slate-500">Max 80 characters, no spammy words, never much shorter than the current title.</p>
            <div className="ml-11 mt-3 max-w-3xl">
              <Field
                label="Title format (optional)"
                hint={
                  <>
                    Parts in <code className="rounded bg-slate-100 px-1">{"{braces}"}</code> are filled in by Claude in this order; any
                    text outside braces (like <code className="rounded bg-slate-100 px-1">Used OEM</code>) must appear in every new title
                    or it is rejected. Leave empty for no fixed format.
                  </>
                }
              >
                <input
                  className="input font-mono"
                  value={s.modules.title.template ?? ""}
                  disabled={!s.modules.title.enabled}
                  placeholder="{Year range} {Brand} {Model} {Part name and location} {Part number} Used OEM"
                  onChange={(e) => up("modules.title.template", e.target.value)}
                />
              </Field>
              {!s.modules.title.template && (
                <button
                  type="button"
                  className="mt-1 text-xs font-medium text-brand-600 hover:underline"
                  onClick={() => up("modules.title.template", "{Year range} {Brand} {Model} {Part name and location} {Part number} Used OEM")}
                >
                  Use the auto-parts format: Year range › Brand › Model › Part name & location › Part number › Used OEM
                </button>
              )}
            </div>
          </div>

          <div>
            <Toggle checked={s.modules.pricing.enabled} onChange={(v) => up("modules.pricing.enabled", v)} label={<b>Prices</b>} />
            <div className="ml-11 mt-3 grid gap-4 md:grid-cols-4">
              <Field label="Max change per edit (%)">
                <Num value={s.modules.pricing.maxChangePct} step={0.5} onChange={(v) => up("modules.pricing.maxChangePct", v)} />
              </Field>
              <Field label="Min margin over cost (%)">
                <Num value={s.modules.pricing.minMarginPct} onChange={(v) => up("modules.pricing.minMarginPct", v)} />
              </Field>
              <Field label="eBay fees (%)">
                <Num value={s.modules.pricing.feePct} step={0.1} onChange={(v) => up("modules.pricing.feePct", v)} />
              </Field>
              <Field label="Absolute min price">
                <Num value={s.modules.pricing.minPrice} step={0.01} onChange={(v) => up("modules.pricing.minPrice", v)} />
              </Field>
            </div>
            <div className="ml-11 mt-3">
              <Toggle
                checked={s.modules.pricing.requireCostForDecrease}
                onChange={(v) => up("modules.pricing.requireCostForDecrease", v)}
                label="Never lower a price unless I've entered my cost for that listing"
              />
            </div>
          </div>

          <div>
            <Toggle checked={s.modules.specifics.enabled} onChange={(v) => up("modules.specifics.enabled", v)} label={<b>Item specifics</b>} />
            <div className="ml-11 mt-2 space-y-3">
              <Toggle
                checked={s.modules.specifics.useOtherListings}
                disabled={!s.modules.specifics.enabled}
                onChange={(v) => up("modules.specifics.useOtherListings", v)}
                label="Learn specifics from other eBay listings with the same part number"
              />
              <Toggle
                checked={s.modules.specifics.allowKnowledge}
                disabled={!s.modules.specifics.enabled}
                onChange={(v) => up("modules.specifics.allowKnowledge", v)}
                label="Let Claude add part-level facts it knows for the part number (interchange numbers, features… high confidence only)"
              />
              <Toggle
                checked={s.modules.specifics.allowCustomNames}
                disabled={!s.modules.specifics.enabled}
                onChange={(v) => up("modules.specifics.allowCustomNames", v)}
                label="Allow useful specifics not in eBay's list for the category (Interchange / Superseded / OE part numbers…)"
              />
              <Toggle
                checked={s.modules.specifics.overwriteExisting}
                disabled={!s.modules.specifics.enabled}
                onChange={(v) => up("modules.specifics.overwriteExisting", v)}
                label="Also correct existing specifics (default: only add missing ones)"
              />
              <p className="text-xs text-slate-500">
                Color, condition, warranty and included items always come from your own listing - never from other sellers or Claude&apos;s
                knowledge. eBay allows up to 45 specifics per listing.
              </p>
            </div>
          </div>

          <div>
            <Toggle
              checked={s.modules.compatibility.enabled}
              onChange={(v) => up("modules.compatibility.enabled", v)}
              label={<b>Parts compatibility (fitment)</b>}
            />
            <div className="ml-11 mt-2 space-y-3">
              <Toggle
                checked={s.modules.compatibility.researchEbay}
                disabled={!s.modules.compatibility.enabled}
                onChange={(v) => up("modules.compatibility.researchEbay", v)}
                label="Research fitment from other eBay listings with the same part number"
              />
              <Toggle
                checked={s.modules.compatibility.allowKnowledge}
                disabled={!s.modules.compatibility.enabled}
                onChange={(v) => up("modules.compatibility.allowKnowledge", v)}
                label="Let Claude add vehicles from its knowledge of the part number (high confidence only, checked against eBay's vehicle catalog)"
              />
              <div className="grid max-w-xl gap-4 sm:grid-cols-2">
                <Field
                  label="Listings that must agree"
                  hint="A vehicle from other listings is used only if at least this many of them include it."
                >
                  <Num value={s.modules.compatibility.minListings} min={1} onChange={(v) => up("modules.compatibility.minListings", v)} />
                </Field>
                <Field label="Reference listings to read" hint="More = fuller fitment, slightly slower. Max 10.">
                  <Num
                    value={s.modules.compatibility.maxReferenceListings}
                    min={1}
                    onChange={(v) => up("modules.compatibility.maxReferenceListings", v)}
                  />
                </Field>
              </div>
              <Toggle
                checked={s.modules.compatibility.apply}
                disabled={!s.modules.compatibility.enabled}
                onChange={(v) => up("modules.compatibility.apply", v)}
                label={<b>Push fitment to eBay (off = show it in the review screen only)</b>}
              />
              {s.modules.compatibility.apply && (
                <Alert kind="warning">
                  Fitment is added to the listing&apos;s compatibility table (existing vehicles are kept). Wrong fitment causes returns,
                  so check a few batches first.
                </Alert>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Danger zone">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-slate-600">Remove this eBay account and all of its data from the app. Your eBay listings are not affected.</p>
          <Button variant="danger" onClick={disconnect}>
            Disconnect store
          </Button>
        </div>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-end gap-3 px-4 py-3">
          {dirty && <span className="text-sm text-amber-700">Unsaved changes</span>}
          <Button
            variant="secondary"
            disabled={!dirty}
            onClick={() => {
              setS(store.settings);
              setName(store.name);
              setDirty(false);
            }}
          >
            Discard
          </Button>
          <Button onClick={save} loading={saving} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      </div>
    </div>
  );
}
