"use client";
import { Code2, Eye, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, money } from "@/lib/api";
import { computeWeights, kg, pickPolicy } from "@/lib/shipping";
import type { CategoryAspect, CompatRow, EbayItem, PackageDetails, ShippingPolicy, StoreSettings } from "@/lib/types";
import { toast } from "../toast";
import { Alert, Badge, Button, Card, cx } from "../ui";
import { CompatibilityTable } from "./CompatibilityTable";
import { DescriptionFrame } from "./DescriptionFrame";

interface SpecRow {
  id: number;
  name: string;
  values: string; // comma-separated in the editor
}

const rowKey = (r: CompatRow) => `${r.Year}|${r.Make}|${r.Model}|${r.Trim ?? ""}|${r.Engine ?? ""}`.toLowerCase();
const toSpecRows = (s: Record<string, string[]>): SpecRow[] => Object.entries(s).map(([name, v], i) => ({ id: i, name, values: v.join(", ") }));
const fromSpecRows = (rows: SpecRow[]) => {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const name = r.name.trim();
    const values = r.values
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (name && values.length) out[name] = values;
  }
  return out;
};
const normSpecs = (s: Record<string, string[]>) =>
  JSON.stringify(
    Object.entries(s)
      .map(([k, v]) => [k.toLowerCase(), [...v].sort()])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );

/** Edit form for one listing; saves changed fields straight to eBay. */
export function ListingEditor({
  storeId,
  item,
  aspects,
  shippingPolicies = [],
  shippingSettings = { enabled: true, apply: false, divisor: 5000, minKg: 3, maxKg: 60, useEstimates: true },
  onSaved,
}: {
  storeId: string;
  item: EbayItem;
  aspects: CategoryAspect[];
  shippingPolicies?: ShippingPolicy[];
  shippingSettings?: StoreSettings["modules"]["shipping"];
  onSaved: () => void;
}) {
  const initialQty = Math.max(0, item.quantity - (item.quantitySold ?? 0));
  const pkgToForm = (p?: PackageDetails) => ({
    weightKg: p?.weightKg ? String(p.weightKg) : "",
    lengthCm: p?.lengthCm ? String(p.lengthCm) : "",
    widthCm: p?.widthCm ? String(p.widthCm) : "",
    heightCm: p?.heightCm ? String(p.heightCm) : "",
  });
  const [policyId, setPolicyId] = useState(item.shipping?.policyId ?? "");
  const [pkg, setPkg] = useState(() => pkgToForm(item.shipping?.package));
  const [title, setTitle] = useState(item.title);
  const [price, setPrice] = useState(String(item.price));
  const [qty, setQty] = useState(String(initialQty));
  const [specs, setSpecs] = useState<SpecRow[]>(() => toSpecRows(item.itemSpecifics ?? {}));
  const [compat, setCompat] = useState<CompatRow[]>(item.compatibilityAll ?? []);
  const [desc, setDesc] = useState(item.descriptionHtml ?? "");
  const [descView, setDescView] = useState<"code" | "preview">("preview");
  const [newRow, setNewRow] = useState<CompatRow>({ Year: "", Make: "", Model: "", Trim: "", Engine: "" });
  const [bulk, setBulk] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [saving, setSaving] = useState(false);

  // reset when a fresh copy of the listing arrives (after save)
  useEffect(() => {
    setTitle(item.title);
    setPrice(String(item.price));
    setQty(String(Math.max(0, item.quantity - (item.quantitySold ?? 0))));
    setSpecs(toSpecRows(item.itemSpecifics ?? {}));
    setCompat(item.compatibilityAll ?? []);
    setDesc(item.descriptionHtml ?? "");
    setPolicyId(item.shipping?.policyId ?? "");
    setPkg(pkgToForm(item.shipping?.package));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  // live shipping maths
  const pkgNum: PackageDetails = {
    weightKg: Number(pkg.weightKg) || 0,
    lengthCm: Number(pkg.lengthCm) || 0,
    widthCm: Number(pkg.widthCm) || 0,
    heightCm: Number(pkg.heightCm) || 0,
  };
  const weights = computeWeights(pkgNum, shippingSettings.divisor, shippingSettings.minKg);
  const currentPolicy = shippingPolicies.find((p) => p.id === (item.shipping?.policyId ?? "")) ?? null;
  // a part-name policy (e.g. "Engine") only needs the title; weight brackets need a weight
  const suggestedPolicy =
    pickPolicy(shippingPolicies, weights.categoryKg, title, currentPolicy, pkgNum.weightKg > 0) ?? null;
  const origPkg = pkgToForm(item.shipping?.package);

  const original = useMemo(() => new Set((item.compatibilityAll ?? []).map(rowKey)), [item]);
  const added = useMemo(() => new Set(compat.map(rowKey).filter((k) => !original.has(k))), [compat, original]);
  const removedCount = useMemo(() => {
    const now = new Set(compat.map(rowKey));
    return [...original].filter((k) => !now.has(k)).length;
  }, [compat, original]);

  const specObj = fromSpecRows(specs);
  const dirty = {
    title: title.trim() !== item.title.trim(),
    price: !item.hasVariations && Number(price) !== item.price,
    quantity: !item.hasVariations && Number(qty) !== initialQty,
    itemSpecifics: normSpecs(specObj) !== normSpecs(item.itemSpecifics ?? {}),
    compatibility: added.size > 0 || removedCount > 0,
    description: desc !== (item.descriptionHtml ?? ""),
    shippingPolicy: Boolean(policyId) && policyId !== (item.shipping?.policyId ?? ""),
    packageDetails: JSON.stringify(pkg) !== JSON.stringify(origPkg) && pkgNum.weightKg > 0,
  };
  const changedLabels = Object.entries(dirty)
    .filter(([, v]) => v)
    .map(
      ([k]) =>
        ({
          title: "Title",
          price: "Price",
          quantity: "Quantity",
          itemSpecifics: "Item specifics",
          compatibility: "Compatibility",
          description: "Description",
          shippingPolicy: "Shipping policy",
          packageDetails: "Package weight & size",
        })[k]!,
    );

  const usedNames = new Set(specs.map((s) => s.name.trim().toLowerCase()));
  const missingRequired = aspects.filter((a) => (a.required || a.usage === "RECOMMENDED") && !usedNames.has(a.name.toLowerCase()));
  const aspectByName = new Map(aspects.map((a) => [a.name.toLowerCase(), a]));

  function addSpec(name = "") {
    setSpecs((s) => [...s, { id: Date.now() + Math.random(), name, values: "" }]);
  }

  function addCompatRow() {
    const r: CompatRow = {
      Year: newRow.Year.trim(),
      Make: newRow.Make.trim(),
      Model: newRow.Model.trim(),
      ...(newRow.Trim?.trim() ? { Trim: newRow.Trim.trim() } : {}),
      ...(newRow.Engine?.trim() ? { Engine: newRow.Engine.trim() } : {}),
    };
    if (!/^(19|20)\d\d$/.test(r.Year) || !r.Make || !r.Model) return toast.error("Year (4 digits), Make and Model are required");
    if (compat.some((c) => rowKey(c) === rowKey(r))) return toast.info("That vehicle is already listed");
    setCompat((c) => [...c, r]);
    setNewRow((n) => ({ ...n, Year: "" }));
  }

  function addBulk() {
    const rows: CompatRow[] = [];
    for (const line of bulk.split(/\r?\n/)) {
      const parts = line.split(/\t|,/).map((p) => p.trim());
      if (parts.length < 3 || !/^(19|20)\d\d$/.test(parts[0]) || !parts[1] || !parts[2]) continue;
      const [Year, Make, Model, Trim, Engine] = parts;
      rows.push({ Year, Make, Model, ...(Trim ? { Trim } : {}), ...(Engine ? { Engine } : {}) });
    }
    if (!rows.length) return toast.error("No valid lines. Use: Year, Make, Model, Trim, Engine - one vehicle per line");
    const existing = new Set(compat.map(rowKey));
    const fresh = rows.filter((r) => !existing.has(rowKey(r)));
    setCompat((c) => [...c, ...fresh]);
    setBulk("");
    setShowBulk(false);
    toast.success(`${fresh.length} vehicle(s) added${rows.length - fresh.length ? `, ${rows.length - fresh.length} already listed` : ""}`);
  }

  function discard() {
    setTitle(item.title);
    setPrice(String(item.price));
    setQty(String(initialQty));
    setSpecs(toSpecRows(item.itemSpecifics ?? {}));
    setCompat(item.compatibilityAll ?? []);
    setDesc(item.descriptionHtml ?? "");
    setPolicyId(item.shipping?.policyId ?? "");
    setPkg(pkgToForm(item.shipping?.package));
  }

  async function save() {
    if (title.trim().length > 80) return toast.error("Title is longer than 80 characters");
    if (!confirm(`Save ${changedLabels.join(", ")} to eBay now?`)) return;
    const body: Record<string, unknown> = {};
    if (dirty.title) body.title = title;
    if (dirty.price) body.price = Number(price);
    if (dirty.quantity) body.quantityAvailable = Number(qty);
    if (dirty.itemSpecifics) body.itemSpecifics = specObj;
    if (dirty.compatibility) body.compatibility = compat;
    if (dirty.description) body.description = desc;
    if (dirty.shippingPolicy) body.shippingPolicyId = policyId;
    if (dirty.packageDetails) body.packageDetails = pkgNum;
    setSaving(true);
    try {
      const r = await api<{ changed: string[]; warnings: string[] }>(`/stores/${storeId}/listings/${item.itemId}`, { method: "PUT", body });
      toast.success(`Saved to eBay: ${r.changed.join(", ")}`);
      if (r.warnings?.length) toast.info(`eBay notes: ${r.warnings.slice(0, 2).join(" | ")}`);
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 pb-24">
      <Card title="Title, price & quantity">
        <div className="space-y-4">
          <div>
            <label className="label">
              Title <span className={cx("normal-case", title.trim().length > 80 ? "text-rose-600" : "text-slate-400")}>({title.trim().length}/80)</span>
            </label>
            <input className="input text-base" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Price ({item.currency})</label>
              <input className="input" type="number" step="0.01" min="0" value={price} disabled={item.hasVariations} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div>
              <label className="label">Available quantity</label>
              <input className="input" type="number" step="1" min="0" value={qty} disabled={item.hasVariations} onChange={(e) => setQty(e.target.value)} />
              <p className="mt-1 text-xs text-slate-500">{item.quantitySold ?? 0} sold so far</p>
            </div>
            <div>
              <label className="label">Condition</label>
              <div className="input bg-slate-50 text-slate-600">{item.condition || "—"}</div>
              <p className="mt-1 text-xs text-slate-500">Change condition on eBay</p>
            </div>
          </div>
          {item.hasVariations && <Alert kind="info">This listing has variations - price and quantity are managed per variation on eBay.</Alert>}
        </div>
      </Card>

      <Card
        title={`Item specifics (${Object.keys(specObj).length}/45)`}
        actions={
          <Button size="sm" variant="secondary" onClick={() => addSpec()}>
            <Plus className="h-3.5 w-3.5" /> Add specific
          </Button>
        }
      >
        {missingRequired.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium text-slate-600">Missing for this category:</span>
            {missingRequired.slice(0, 15).map((a) => (
              <button key={a.name} onClick={() => addSpec(a.name)} title="Add this specific">
                <Badge color={a.required ? "red" : "yellow"}>
                  + {a.name}
                  {a.required ? " (required)" : ""}
                </Badge>
              </button>
            ))}
          </div>
        )}
        <datalist id="aspect-names">
          {aspects.map((a) => (
            <option key={a.name} value={a.name} />
          ))}
          {["Interchange Part Number", "Superseded Part Number", "OE/OEM Part Number"].map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <div className="space-y-2">
          {specs.map((s) => {
            const a = aspectByName.get(s.name.trim().toLowerCase());
            const listId = a?.values.length ? `vals-${s.id}` : undefined;
            return (
              <div key={s.id} className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] items-start gap-2">
                <input
                  className="input"
                  list="aspect-names"
                  placeholder="Name"
                  value={s.name}
                  onChange={(e) => setSpecs((rows) => rows.map((r) => (r.id === s.id ? { ...r, name: e.target.value } : r)))}
                />
                <div>
                  <input
                    className="input"
                    list={listId}
                    placeholder={a?.multi ? "Value(s), comma-separated" : "Value"}
                    value={s.values}
                    onChange={(e) => setSpecs((rows) => rows.map((r) => (r.id === s.id ? { ...r, values: e.target.value } : r)))}
                  />
                  {listId && (
                    <datalist id={listId}>
                      {a!.values.map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  )}
                  {a?.mode === "SELECTION_ONLY" && <p className="mt-0.5 text-[11px] text-slate-400">Pick one of eBay&apos;s values for this field</p>}
                </div>
                <button
                  onClick={() => setSpecs((rows) => rows.filter((r) => r.id !== s.id))}
                  className="mt-1.5 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  title="Remove specific"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
          {!specs.length && <p className="text-sm text-slate-500">No item specifics yet.</p>}
        </div>
      </Card>

      <Card
        title={`Compatibility (${compat.length} vehicles)`}
        actions={
          <>
            {(added.size > 0 || removedCount > 0) && (
              <span className="text-xs text-slate-500">
                {added.size > 0 && <span className="text-emerald-700">+{added.size} new</span>}
                {added.size > 0 && removedCount > 0 && " · "}
                {removedCount > 0 && <span className="text-rose-600">−{removedCount} removed</span>}
              </span>
            )}
            <Button size="sm" variant="secondary" onClick={() => setShowBulk((v) => !v)}>
              Paste list
            </Button>
            {compat.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => confirm("Remove all vehicles from this listing's compatibility?") && setCompat([])}>
                Remove all
              </Button>
            )}
          </>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]">
          {(["Year", "Make", "Model", "Trim", "Engine"] as const).map((f) => (
            <input
              key={f}
              className="input"
              placeholder={f === "Trim" || f === "Engine" ? `${f} (optional)` : f}
              value={newRow[f] ?? ""}
              onChange={(e) => setNewRow((n) => ({ ...n, [f]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && addCompatRow()}
            />
          ))}
          <Button size="sm" onClick={addCompatRow} className="col-span-2 sm:col-span-1">
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
        {showBulk && (
          <div className="mb-4 rounded-lg bg-slate-50 p-3">
            <p className="mb-2 text-xs text-slate-600">One vehicle per line: Year, Make, Model, Trim, Engine (Trim/Engine optional). Tab-separated from Excel works too.</p>
            <textarea className="input h-32 font-mono text-xs" value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"2009, Audi, TT Quattro, Base Coupe 2-Door, 2.0L 1984CC l4 GAS DOHC Turbocharged"} />
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={addBulk} disabled={!bulk.trim()}>
                Add vehicles
              </Button>
            </div>
          </div>
        )}
        <CompatibilityTable rows={compat} highlight={added} onRemove={(r) => setCompat((c) => c.filter((x) => rowKey(x) !== rowKey(r)))} />
        <p className="mt-3 text-xs text-slate-500">
          Saving replaces the listing&apos;s whole compatibility list with this one. Use eBay&apos;s exact Make/Model/Trim/Engine spelling - eBay rejects vehicles it doesn&apos;t
          recognise.
        </p>
      </Card>

      <Card title="Shipping">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div>
              <label className="label">Package weight & box size (packed)</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["weightKg", "Weight", "kg"],
                    ["lengthCm", "Length", "cm"],
                    ["widthCm", "Width", "cm"],
                    ["heightCm", "Height", "cm"],
                  ] as const
                ).map(([k, label, unit]) => (
                  <div key={k} className="relative">
                    <input
                      className="input pr-9"
                      type="number"
                      min="0"
                      step={k === "weightKg" ? "0.1" : "1"}
                      placeholder={label}
                      value={pkg[k]}
                      onChange={(e) => setPkg((p) => ({ ...p, [k]: e.target.value }))}
                    />
                    <span className="pointer-events-none absolute right-2.5 top-2 text-xs text-slate-400">{unit}</span>
                  </div>
                ))}
              </div>
              {!item.shipping?.package && <p className="mt-1 text-xs text-slate-500">This listing has no package details on eBay yet.</p>}
            </div>
            <div>
              <label className="label">Shipping policy</label>
              <select className="input" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                {!policyId && <option value="">{item.shipping?.policy || "— none —"}</option>}
                {policyId && !shippingPolicies.some((p) => p.id === policyId) && <option value={policyId}>{item.shipping?.policy || policyId}</option>}
                {[...shippingPolicies]
                  .sort((a, b) => (a.kg ?? 999) - (b.kg ?? 999) || a.name.localeCompare(b.name))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="rounded-lg bg-slate-50 p-4 text-sm">
            {pkgNum.weightKg > 0 ? (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <dt className="text-slate-500">Actual weight</dt>
                  <dd className="text-right font-medium tabular-nums">{kg(weights.actualKg)}</dd>
                  <dt className="text-slate-500">Dimensional (÷{shippingSettings.divisor})</dt>
                  <dd className="text-right font-medium tabular-nums">{weights.dimensionalKg ? kg(weights.dimensionalKg) : "add box size"}</dd>
                  <dt className="text-slate-500">Billable weight</dt>
                  <dd className="text-right font-semibold tabular-nums">{kg(weights.billableKg)}</dd>
                  <dt className="text-slate-500">Weight bracket (min {shippingSettings.minKg} kg)</dt>
                  <dd className="text-right font-semibold tabular-nums text-brand-700">{weights.categoryKg} kg</dd>
                </dl>
                <div className="mt-3 border-t border-slate-200 pt-3">
                  {weights.categoryKg > shippingSettings.maxKg ? (
                    <p className="text-amber-700">Over your {shippingSettings.maxKg} kg maximum - consider freight.</p>
                  ) : suggestedPolicy ? (
                    suggestedPolicy.id === policyId ? (
                      <p className="text-emerald-700">✓ The selected policy matches ({suggestedPolicy.name}).</p>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-amber-800">
                          Suggested: <b>{suggestedPolicy.name}</b>
                        </span>
                        <Button size="sm" variant="secondary" onClick={() => setPolicyId(suggestedPolicy.id)}>
                          Use suggested policy
                        </Button>
                      </div>
                    )
                  ) : (
                    <p className="text-slate-500">No weight-based policy found for {weights.categoryKg} kg.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-slate-500">Enter the packed weight (and box size) to calculate the dimensional and billable weight and the right policy.</p>
            )}
          </div>
        </div>
      </Card>

      <Card
        title="Description"
        actions={
          <div className="flex rounded-md border border-slate-200 p-0.5">
            <button
              onClick={() => setDescView("preview")}
              className={cx("flex items-center gap-1 rounded px-2 py-1 text-xs", descView === "preview" ? "bg-slate-900 text-white" : "text-slate-600")}
            >
              <Eye className="h-3.5 w-3.5" /> Preview
            </button>
            <button
              onClick={() => setDescView("code")}
              className={cx("flex items-center gap-1 rounded px-2 py-1 text-xs", descView === "code" ? "bg-slate-900 text-white" : "text-slate-600")}
            >
              <Code2 className="h-3.5 w-3.5" /> HTML
            </button>
          </div>
        }
      >
        {descView === "code" ? (
          <textarea className="input h-96 font-mono text-xs leading-relaxed" value={desc} onChange={(e) => setDesc(e.target.value)} spellCheck={false} />
        ) : (
          <DescriptionFrame html={desc} minHeight={200} />
        )}
        <p className="mt-2 text-xs text-slate-500">eBay doesn&apos;t allow JavaScript or active content in descriptions.</p>
      </Card>

      {/* sticky save bar */}
      <div
        className={cx(
          "fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur transition lg:left-[var(--sidebar-w,16rem)]",
          changedLabels.length ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-end gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <span className="mr-auto text-sm text-amber-700">
            {changedLabels.length} unsaved change{changedLabels.length === 1 ? "" : "s"}: {changedLabels.join(", ")}
            {dirty.price && ` (${money(item.price)} → ${money(Number(price))})`}
          </span>
          <Button variant="secondary" onClick={discard} disabled={saving}>
            Discard
          </Button>
          <Button onClick={save} loading={saving}>
            Save to eBay
          </Button>
        </div>
      </div>
    </div>
  );
}
