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
    compatibility: { enabled: true, apply: false, researchEbay: true, allowKnowledge: true, minListings: 2, maxReferenceListings: 5 },
  },
};

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
  return out;
}

export function migrateTitleTemplate(t: string): string {
  return (t || "").replace(/\bUsed OEM\b/gi, "OEM Used");
}
