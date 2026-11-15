import { Schema, model, Types, HydratedDocument } from "mongoose";

/** Everything a user can tune per eBay store. Defaults = safe "review" mode. */
export interface StoreSettings {
  mode: "review" | "auto";
  batchSize: number;
  gapBetweenListingsSec: number;
  gapBetweenPushesSec: number;
  gapBetweenBatchesMin: number;
  cooldownDays: number;
  resyncHours: number;
  activeHours: { enabled: boolean; start: string; end: string; timezone: string };
  competitorCount: number;
  excludeSeller: string;
  claude: {
    model: string;
    effort: "low" | "medium" | "high";
    monthlyBudgetUsd: number;
    inputPricePerMtok: number;
    outputPricePerMtok: number;
  };
  modules: {
    /** template: the store's title format, e.g. "{Year range} {Brand} {Model} {Part name and location} {Part number} OEM Used".
     *  {…} parts are filled in by Claude in that order; text outside {…} must appear in every title. "" = no fixed format. */
    title: { enabled: boolean; template: string };
    pricing: {
      enabled: boolean;
      maxChangePct: number;
      requireCostForDecrease: boolean;
      minMarginPct: number;
      feePct: number;
      minPrice: number;
    };
    /** useOtherListings = learn specifics from other listings of the same part number; allowKnowledge = let Claude
     *  fill part-level facts (interchange numbers, features…) from its knowledge (high confidence only);
     *  allowCustomNames = allow useful specifics that aren't in eBay's list for the category (e.g. Interchange Part Number) */
    specifics: {
      enabled: boolean;
      overwriteExisting: boolean;
      useOtherListings: boolean;
      allowKnowledge: boolean;
      allowCustomNames: boolean;
    };
    /** Shipping weight analysis. apply = switch listings to the suggested policy (else report only);
     *  divisor = dimensional weight divisor (cm³/kg); minKg = smallest bracket used; useEstimates = let Claude
     *  estimate packed weight/size when the listing has none */
    shipping: {
      enabled: boolean;
      apply: boolean;
      divisor: number;
      minKg: number;
      maxKg: number;
      useEstimates: boolean;
    };
    /** Branded A+ description: Claude writes the content, the store's branded template lays it out.
     *  brandName "" = use the eBay store name. keepOriginalNotes = keep the old description text in a
     *  "Seller notes" section. Policy texts are shown as info boxes (empty = hidden). */
    description: {
      enabled: boolean;
      brandName: string;
      /** part of the brand name shown in the accent colour, e.g. "Supply" */
      brandHighlight: string;
      tagline: string;
      logoUrl: string;
      accentColor: string;
      /** header/footer/table background */
      darkColor: string;
      /** up to 4 trust badges under the header */
      badges: string[];
      footerText: string;
      /** https link to the store banner image (shown full width under the menu) */
      bannerUrl: string;
      /** eBay store link for the menu, e.g. https://www.ebay.com/str/yourstore ("" = all items search) */
      storeUrl: string;
      /** "You may also like": other items from this store */
      showRelated: boolean;
      relatedCount: number;
      showFaq: boolean;
      showPhotos: boolean;
      showCompatibility: boolean;
      keepOriginalNotes: boolean;
      shippingText: string;
      returnsText: string;
      warrantyText: string;
      contactText: string;
    };
    /** apply = push fitment to eBay (else report only); researchEbay = learn fitment from other listings of the
     *  same part number; allowKnowledge = let Claude add vehicles from its knowledge of the part number (verified
     *  against eBay's catalog); minListings = how many reference listings must agree on a vehicle */
    compatibility: {
      enabled: boolean;
      apply: boolean;
      researchEbay: boolean;
      allowKnowledge: boolean;
      minListings: number;
      maxReferenceListings: number;
    };
  };
}

export const DEFAULT_SETTINGS: StoreSettings = {
  mode: "review",
  batchSize: 20,
  gapBetweenListingsSec: 20,
  gapBetweenPushesSec: 5,
  gapBetweenBatchesMin: 60,
  cooldownDays: 21,
  resyncHours: 12,
  activeHours: { enabled: true, start: "08:00", end: "23:00", timezone: "America/New_York" },
  competitorCount: 15,
  excludeSeller: "",
  claude: {
    model: "claude-opus-5-5",
    effort: "medium",
    monthlyBudgetUsd: 90,
    inputPricePerMtok: 4,
    outputPricePerMtok: 20,
  },
  modules: {
    title: { enabled: true, template: "" },
    pricing: {
      enabled: true,
      maxChangePct: 5,
      requireCostForDecrease: true,
      minMarginPct: 15,
      feePct: 13.5,
      minPrice: 0,
    },
    specifics: { enabled: true, overwriteExisting: false, useOtherListings: true, allowKnowledge: true, allowCustomNames: true },
    shipping: { enabled: true, apply: false, divisor: 5000, minKg: 3, maxKg: 60, useEstimates: true },
    description: DEFAULT_DESCRIPTION(),
    compatibility: { enabled: true, apply: true, researchEbay: true, allowKnowledge: true, minListings: 2, maxReferenceListings: 5 },
  },
};

export function DEFAULT_DESCRIPTION(): StoreSettings["modules"]["description"] {
  return {
    enabled: true,
    brandName: "MotorSupply Co",
    brandHighlight: "Supply",
    tagline: "Driving auto parts to you",
    logoUrl: "",
    accentColor: "#e11d2a",
    darkColor: "#0b0f19",
    badges: ["Quality parts", "Fast shipping", "Wide selection", "Global delivery"],
    footerText: "Thank you for your business.",
    bannerUrl: "",
    storeUrl: "",
    showRelated: true,
    relatedCount: 4,
    showFaq: true,
    showPhotos: true,
    showCompatibility: true,
    keepOriginalNotes: true,
    shippingText: "Ships within the handling time shown on this listing. Every part is carefully packed to arrive safely.",
    returnsText: "Returns are accepted as shown in this listing's return policy.",
    warrantyText: "",
    contactText: "Not sure it fits? Message us through eBay with your VIN and we will check it for you.",
  };
}

const storeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ebayUserId: { type: String, required: true },
    name: { type: String, required: true },
    marketplaceId: { type: String, default: "EBAY_US" },
    siteId: { type: Number, default: 0 },
    auth: {
      refreshTokenEnc: { type: String, required: true },
      refreshTokenExpiresAt: Date,
      scopes: [String],
    },
    settings: { type: Schema.Types.Mixed, default: () => structuredClone(DEFAULT_SETTINGS) },
    runner: {
      enabled: { type: Boolean, default: false },
      nextRunAt: Date,
      lastBatchAt: Date,
      lastError: { type: String, default: "" },
    },
    lastSyncAt: Date,
  },
  { timestamps: true, minimize: false },
);
storeSchema.index({ userId: 1, ebayUserId: 1 }, { unique: true });

export const Store = model("Store", storeSchema);
export type StoreDocument = HydratedDocument<{
  userId: Types.ObjectId;
  ebayUserId: string;
  name: string;
  marketplaceId: string;
  siteId: number;
  auth: { refreshTokenEnc: string; refreshTokenExpiresAt?: Date; scopes: string[] };
  settings: StoreSettings;
  runner: { enabled: boolean; nextRunAt?: Date; lastBatchAt?: Date; lastError: string };
  lastSyncAt?: Date;
}>;

/** Merge saved settings over defaults so newly added settings always have a value. */
export function resolveSettings(saved: Partial<StoreSettings> | undefined): StoreSettings {
  const merge = (base: any, over: any): any => {
    if (over === undefined || over === null) return structuredClone(base);
    if (typeof base !== "object" || Array.isArray(base)) return over;
    const out: any = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], over[k]);
    return out;
  };
  const out: StoreSettings = merge(DEFAULT_SETTINGS, saved);
  // store format changed: titles now end "OEM Used" (was "Used OEM")
  out.modules.title.template = migrateTitleTemplate(out.modules.title.template);
  // first A+ version defaulted to a generic blue look; untouched -> store branding
  const d = out.modules.description;
  if (d.accentColor.toLowerCase() === "#1e3a8a" && !d.brandName.trim()) {
    const def = DEFAULT_DESCRIPTION();
    Object.assign(d, {
      brandName: def.brandName,
      brandHighlight: def.brandHighlight,
      tagline: def.tagline,
      accentColor: def.accentColor,
      darkColor: def.darkColor,
      badges: def.badges,
      footerText: def.footerText,
    });
  }
  return out;
}

export function migrateTitleTemplate(t: string): string {
  return (t || "").replace(/\bUsed OEM\b/gi, "OEM Used");
}
