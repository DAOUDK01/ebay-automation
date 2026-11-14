import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const descriptionSchema = z.object({
  enabled: z.boolean(),
  brandName: z.string().max(80),
  tagline: z.string().max(160),
  logoUrl: z.union([z.literal(""), z.string().url().max(500).startsWith("https://", "logo URL must start with https://")]),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must look like #1e3a8a"),
  showPhotos: z.boolean(),
  showCompatibility: z.boolean(),
  keepOriginalNotes: z.boolean(),
  shippingText: z.string().max(500),
  returnsText: z.string().max(500),
  warrantyText: z.string().max(500),
  contactText: z.string().max(500),
});

export const settingsSchema = z.object({
  mode: z.enum(["review", "auto"]),
  batchSize: z.number().int().min(1).max(200),
  gapBetweenListingsSec: z.number().min(0).max(3600),
  gapBetweenPushesSec: z.number().min(0).max(600),
  gapBetweenBatchesMin: z.number().min(1).max(10080),
  cooldownDays: z.number().int().min(1).max(365),
  resyncHours: z.number().min(1).max(168),
  activeHours: z.object({
    enabled: z.boolean(),
    start: hhmm,
    end: hhmm,
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown timezone"),
  }),
  competitorCount: z.number().int().min(3).max(50),
  excludeSeller: z.string().max(64),
  claude: z.object({
    model: z.string().min(3),
    effort: z.enum(["low", "medium", "high"]),
    monthlyBudgetUsd: z.number().min(0).max(100000),
    inputPricePerMtok: z.number().min(0),
    outputPricePerMtok: z.number().min(0),
  }),
  modules: z.object({
    title: z.object({ enabled: z.boolean(), template: z.string().max(300).default("") }),
    pricing: z.object({
      enabled: z.boolean(),
      maxChangePct: z.number().min(0).max(50),
      requireCostForDecrease: z.boolean(),
      minMarginPct: z.number().min(0).max(500),
      feePct: z.number().min(0).max(60),
      minPrice: z.number().min(0),
    }),
    specifics: z.object({
      enabled: z.boolean(),
      overwriteExisting: z.boolean(),
      useOtherListings: z.boolean().default(true),
      allowKnowledge: z.boolean().default(true),
      allowCustomNames: z.boolean().default(true),
    }),
    shipping: z
      .object({
        enabled: z.boolean(),
        apply: z.boolean(),
        divisor: z.number().min(1000).max(10000),
        minKg: z.number().min(0).max(100),
        maxKg: z.number().min(1).max(1000),
        useEstimates: z.boolean(),
      })
      .default({ enabled: true, apply: false, divisor: 5000, minKg: 3, maxKg: 60, useEstimates: true }),
    description: descriptionSchema.optional(),
    compatibility: z.object({
      enabled: z.boolean(),
      apply: z.boolean(),
      researchEbay: z.boolean().default(true),
      allowKnowledge: z.boolean().default(true),
      minListings: z.number().int().min(1).max(10).default(2),
      maxReferenceListings: z.number().int().min(1).max(10).default(5),
    }),
  }),
});
