/** Inventory module data: one stock snapshot per eBay item, plus per-store inventory settings. */
import { Schema, model, type Types } from "mongoose";

export const STATUSES = ["active", "ended", "unsold"] as const;
export type InventoryStatus = (typeof STATUSES)[number];

const inventorySchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    itemId: { type: String, required: true },
    title: { type: String, default: "" },
    sku: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    url: { type: String, default: "" },
    listingType: { type: String, default: "" },
    price: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    /** total listed quantity (sold + available) */
    quantity: { type: Number, default: 0 },
    quantityAvailable: { type: Number, default: 0 },
    quantitySold: { type: Number, default: 0 },
    watchers: { type: Number, default: 0 },
    /** active = live on eBay; unsold = ended without a sale; ended = ended after selling (or ended by you) */
    status: { type: String, enum: STATUSES, default: "active" },
    /** multi-variation listings: quantity/price live on each variation, so the item-level edit is disabled */
    hasVariations: { type: Boolean, default: false },
    startTime: { type: Date, default: null },
    endTime: { type: Date, default: null },
    /** the new item id after a relist from this app */
    relistedAs: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
inventorySchema.index({ storeId: 1, itemId: 1 }, { unique: true });
inventorySchema.index({ storeId: 1, status: 1, quantityAvailable: 1 });
inventorySchema.index({ storeId: 1, sku: 1 });

export const InventoryItem = model("InventoryItem", inventorySchema);

export const DEFAULT_LOW_STOCK = 1;

const settingsSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, unique: true },
    /** active listings with this many or fewer available count as low stock (badge + "Low stock" tab) */
    lowStockThreshold: { type: Number, default: DEFAULT_LOW_STOCK, min: 0 },
  },
  { timestamps: true },
);

export const InventorySettings = model("InventorySettings", settingsSchema);

export async function inventorySettings(storeId: Types.ObjectId | string) {
  return InventorySettings.findOneAndUpdate({ storeId }, { $setOnInsert: { storeId } }, { upsert: true, returnDocument: "after" });
}
