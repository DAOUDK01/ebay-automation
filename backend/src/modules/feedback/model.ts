/** Feedback module data: feedback received/left, transactions awaiting feedback, per-store settings. */
import { Schema, model, type InferSchemaType, type Types } from "mongoose";

export const RATINGS = ["Positive", "Neutral", "Negative", "Withdrawn"] as const;
export type Rating = (typeof RATINGS)[number];

/** One feedback entry. direction: received = buyers rating us, left = us rating buyers. */
const feedbackSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    feedbackId: { type: String, required: true },
    direction: { type: String, enum: ["received", "left"], required: true },
    /** the role we had in the transaction (Seller when a buyer rated us) */
    role: { type: String, default: "" },
    rating: { type: String, enum: RATINGS, required: true },
    comment: { type: String, default: "" },
    /** the other party: who left it (received) or who we left it for (left, when eBay tells us) */
    user: { type: String, default: "" },
    userScore: { type: Number, default: null },
    itemId: { type: String, default: "" },
    itemTitle: { type: String, default: "" },
    itemPrice: { type: Number, default: null },
    currency: { type: String, default: "USD" },
    transactionId: { type: String, default: "" },
    orderLineItemId: { type: String, default: "" },
    date: { type: Date, required: true },
    /** our public reply (received feedback) */
    response: { type: String, default: "" },
    respondedAt: { type: Date, default: null },
    /** the buyer's follow-up, if any */
    followUp: { type: String, default: "" },
  },
  { timestamps: true },
);
feedbackSchema.index({ storeId: 1, feedbackId: 1 }, { unique: true });
feedbackSchema.index({ storeId: 1, direction: 1, date: -1 });

export const Feedback = model("Feedback", feedbackSchema);
export type FeedbackDoc = InferSchemaType<typeof feedbackSchema> & { _id: Types.ObjectId };

/** A sale where we haven't left feedback for the buyer yet (GetItemsAwaitingFeedback). Replaced on every sync. */
const awaitingSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    itemId: { type: String, required: true },
    transactionId: { type: String, default: "" },
    orderLineItemId: { type: String, default: "" },
    buyer: { type: String, required: true },
    title: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    endTime: { type: Date, default: null },
    lastSyncedAt: Date,
  },
  { timestamps: true },
);
awaitingSchema.index({ storeId: 1, itemId: 1, transactionId: 1 }, { unique: true });

export const FeedbackAwaiting = model("FeedbackAwaiting", awaitingSchema);

export const DEFAULT_AUTO_TEXT = "Great buyer, smooth transaction. Thank you!";

/** Per-store feedback settings + the account's eBay feedback profile (from GetUser / GetFeedback). */
const settingsSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, unique: true },
    /** leave positive feedback for buyers automatically after payment - explicit opt-in, OFF by default */
    autoPositive: { type: Boolean, default: false },
    autoText: { type: String, default: DEFAULT_AUTO_TEXT },
    profile: {
      score: { type: Number, default: null },
      positivePercent: { type: Number, default: null },
      star: { type: String, default: "" },
      /** eBay's own counts per period: { "30": { positive, neutral, negative }, ... } */
      periods: { type: Schema.Types.Mixed, default: null },
      updatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true, minimize: false },
);

export const FeedbackSettings = model("FeedbackSettings", settingsSchema);

/** The store's settings document (created with safe defaults on first use). */
export async function feedbackSettings(storeId: Types.ObjectId | string) {
  return FeedbackSettings.findOneAndUpdate({ storeId }, { $setOnInsert: { storeId } }, { upsert: true, returnDocument: "after" });
}
