import { Schema, model } from "mongoose";

const listingSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    itemId: { type: String, required: true },
    title: String,
    sku: { type: String, default: "" },
    price: Number,
    quantitySold: { type: Number, default: 0 },
    watchCount: { type: Number, default: 0 },
    listingType: String,
    imageUrl: String,
    active: { type: Boolean, default: true },
    lastSyncedAt: Date,
    lastProcessedAt: { type: Date, default: null },
    /** last time optimizing this listing failed (retried after ERROR_RETRY_HOURS) */
    lastErrorAt: { type: Date, default: null },
    /** your landed cost (incl. your shipping cost); enables safe price decreases */
    cost: { type: Number, default: null },
  },
  { timestamps: true },
);
listingSchema.index({ storeId: 1, itemId: 1 }, { unique: true });
listingSchema.index({ storeId: 1, active: 1, lastProcessedAt: 1 });
listingSchema.index({ storeId: 1, sku: 1 });

export const Listing = model("Listing", listingSchema);
