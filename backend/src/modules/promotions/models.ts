/** Promoted Listings campaigns, their ads, and item promotions (markdown sales etc.) synced from the Marketing API. */
import { Schema, model } from "mongoose";

const campaignSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    campaignId: { type: String, required: true },
    name: String,
    status: String, // RUNNING | PAUSED | ENDED | SCHEDULED | PENDING | SYSTEM_PAUSED | ENDING_SOON | DELETED
    fundingModel: String, // COST_PER_SALE (Standard) | COST_PER_CLICK (Advanced)
    bidPercentage: { type: Number, default: null },
    marketplaceId: String,
    startDate: Date,
    endDate: Date,
    adCount: { type: Number, default: 0 },
    /** rules-based (smart) campaigns pick listings themselves; ads can't be added by id */
    rulesBased: { type: Boolean, default: false },
  },
  { timestamps: true },
);
campaignSchema.index({ storeId: 1, campaignId: 1 }, { unique: true });
export const Campaign = model("PrCampaign", campaignSchema);

const adSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    campaignId: { type: String, required: true },
    adId: { type: String, required: true },
    listingId: String,
    bidPercentage: { type: Number, default: null },
    status: String, // ACTIVE | PAUSED | ARCHIVED
  },
  { timestamps: true },
);
adSchema.index({ storeId: 1, campaignId: 1, adId: 1 }, { unique: true });
adSchema.index({ storeId: 1, listingId: 1 });
export const Ad = model("PrAd", adSchema);

const promotionSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    promotionId: { type: String, required: true },
    name: String,
    type: String, // MARKDOWN_SALE | ORDER_DISCOUNT | VOLUME_DISCOUNT | CODED_COUPON
    status: String, // DRAFT | SCHEDULED | RUNNING | PAUSED | ENDED | INVALID
    description: String,
    startDate: Date,
    endDate: Date,
    href: String,
  },
  { timestamps: true },
);
promotionSchema.index({ storeId: 1, promotionId: 1 }, { unique: true });
export const ItemPromotion = model("PrItemPromotion", promotionSchema);
