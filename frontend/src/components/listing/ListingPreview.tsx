"use client";
import { Eye, Heart, MapPin, ShieldCheck, ShoppingCart, Truck } from "lucide-react";
import { useState } from "react";
import { money } from "@/lib/api";
import type { EbayItem } from "@/lib/types";
import { cx } from "../ui";
import { CompatibilityTable } from "./CompatibilityTable";
import { DescriptionFrame } from "./DescriptionFrame";

/** Read-only view laid out like an eBay listing page. */
export function ListingPreview({ item, storeName }: { item: EbayItem; storeName: string }) {
  const pics = item.pictures?.length ? item.pictures : item.imageUrl ? [item.imageUrl] : [];
  const [active, setActive] = useState(0);
  const available = Math.max(0, item.quantity - (item.quantitySold ?? 0));
  const ship = item.shipping?.options?.[0];
  const compat = item.compatibilityAll ?? [];
  const specifics = Object.entries(item.itemSpecifics ?? {});

  return (
    <div className="space-y-8 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      {/* top: gallery + buy box */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div>
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            {pics[active] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pics[active]} alt={item.title} className="h-full w-full object-contain" />
            ) : (
              <span className="text-sm text-slate-400">No photos</span>
            )}
          </div>
          {pics.length > 1 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {pics.map((p, i) => (
                <button
                  key={p + i}
                  onClick={() => setActive(i)}
                  className={cx(
                    "h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 bg-white",
                    i === active ? "border-slate-900" : "border-transparent opacity-80 hover:opacity-100",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-slate-400">{pics.length} photo{pics.length === 1 ? "" : "s"}</p>
        </div>

        <div>
          <h2 className="text-xl font-bold leading-snug text-slate-900 sm:text-2xl">{item.title}</h2>
          {item.subtitle && <p className="mt-1 text-sm text-slate-600">{item.subtitle}</p>}
          <div className="mt-3 flex items-center gap-2 text-sm text-slate-600">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">
              {storeName.slice(0, 1).toUpperCase()}
            </span>
            <span className="font-medium underline decoration-slate-300">{storeName}</span>
          </div>

          <div className="mt-5 border-t border-slate-200 pt-5">
            <div className="text-3xl font-bold text-slate-900">
              <span className="text-lg font-semibold">{item.currency === "USD" ? "US " : `${item.currency} `}</span>
              {money(item.price, item.currency)}
            </div>
            {item.hasVariations && <p className="mt-1 text-xs text-amber-700">This listing has variations - prices shown per variation on eBay.</p>}
          </div>

          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 text-slate-500">Condition:</dt>
              <dd>
                <span className="font-semibold">{item.condition || "—"}</span>
                {item.conditionDescription && <p className="mt-1 text-slate-600">“{item.conditionDescription}”</p>}
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 text-slate-500">Quantity:</dt>
              <dd>
                {available} available{item.quantitySold ? <span className="text-rose-600"> · {item.quantitySold} sold</span> : ""}
              </dd>
            </div>
          </dl>

          <div className="mt-6 space-y-2.5">
            <button disabled className="w-full cursor-default rounded-full bg-[#3665f3] py-3 text-base font-bold text-white opacity-90">
              Buy It Now
            </button>
            <button disabled className="flex w-full cursor-default items-center justify-center gap-2 rounded-full border border-[#3665f3] py-3 text-base font-bold text-[#3665f3]">
              <ShoppingCart className="h-4 w-4" /> Add to cart
            </button>
            <button disabled className="flex w-full cursor-default items-center justify-center gap-2 rounded-full border border-[#3665f3] py-3 text-base font-bold text-[#3665f3]">
              <Heart className="h-4 w-4" /> Add to Watchlist
            </button>
            <p className="flex items-center justify-center gap-1 text-xs text-slate-500">
              <Eye className="h-3.5 w-3.5" /> {item.watchCount ?? 0} watching · preview only
            </p>
          </div>

          <div className="mt-6 space-y-3 rounded-lg border border-slate-200 p-4 text-sm">
            <div className="flex gap-3">
              <Truck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <div>
                <div className="font-semibold">
                  {ship ? (ship.free || Number(ship.cost) === 0 ? "Free shipping" : `${money(Number(ship.cost), item.currency)} shipping`) : "Shipping per policy"}
                </div>
                <div className="text-slate-600">
                  {ship?.service?.replace(/([a-z])([A-Z])/g, "$1 $2")}
                  {item.shipping?.policy ? ` · ${item.shipping.policy}` : ""}
                </div>
                {item.shipping?.dispatchDays && <div className="text-slate-600">Ships within {item.shipping.dispatchDays} business day(s)</div>}
                {item.shipping?.package && (
                  <div className="text-slate-600">
                    Package: {item.shipping.package.weightKg} kg
                    {item.shipping.package.lengthCm > 0 &&
                      ` · ${item.shipping.package.lengthCm}×${item.shipping.package.widthCm}×${item.shipping.package.heightCm} cm`}
                  </div>
                )}
              </div>
            </div>
            {item.shipping?.location && (
              <div className="flex gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                <div className="text-slate-600">Located in: {item.shipping.location}</div>
              </div>
            )}
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <div className="text-slate-600">eBay Money Back Guarantee</div>
            </div>
          </div>
        </div>
      </div>

      {/* about this item */}
      <section>
        <h3 className="mb-3 border-b border-slate-200 pb-2 text-lg font-bold text-slate-900">Item specifics</h3>
        <dl className="grid gap-x-10 gap-y-2.5 text-sm sm:grid-cols-2">
          <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-3">
            <dt className="text-slate-500">Condition</dt>
            <dd className="font-medium text-slate-900">{item.condition || "—"}</dd>
          </div>
          {specifics.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-3">
              <dt className="text-slate-500">{k}</dt>
              <dd className="break-words font-medium text-slate-900">{v.join(", ")}</dd>
            </div>
          ))}
        </dl>
        {!specifics.length && <p className="text-sm text-slate-500">No item specifics.</p>}
      </section>

      <section>
        <h3 className="mb-3 border-b border-slate-200 pb-2 text-lg font-bold text-slate-900">
          Compatibility <span className="text-sm font-normal text-slate-500">({compat.length} vehicles)</span>
        </h3>
        <CompatibilityTable rows={compat} />
      </section>

      <section>
        <h3 className="mb-3 border-b border-slate-200 pb-2 text-lg font-bold text-slate-900">Item description from the seller</h3>
        <DescriptionFrame html={item.descriptionHtml ?? ""} />
      </section>
    </div>
  );
}
