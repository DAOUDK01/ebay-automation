/** Inventory sync, counts and tab filters. */
import type { Types } from "mongoose";
import type { StoreDocument } from "../../models/Store";
import type { Counts, SyncContext, SyncResult } from "../types";
import { mergeLists, sellingList } from "./ebay";
import { InventoryItem, inventorySettings } from "./model";

export const TABS = ["out", "low", "active", "ended"] as const;
export type Tab = (typeof TABS)[number];

/** Mongo filter for one inventory tab. Out of stock = 0 available; low = 1..threshold. */
export function tabFilter(storeId: Types.ObjectId, tab: Tab, threshold: number): Record<string, any> {
  switch (tab) {
    case "out":
      return { storeId, status: "active", quantityAvailable: { $lte: 0 } };
    case "low":
      return { storeId, status: "active", quantityAvailable: { $gt: 0, $lte: threshold } };
    case "ended":
      return { storeId, status: { $in: ["ended", "unsold"] } };
    default:
      return { storeId, status: "active" };
  }
}

export async function syncInventory(ctx: SyncContext): Promise<SyncResult> {
  const { store } = ctx;
  const t = ctx.clients.trading;
  const active = await sellingList(t, "ActiveList");
  const unsold = await sellingList(t, "UnsoldList");
  const sold = await sellingList(t, "SoldList");
  const rows = mergeLists(active, unsold, sold);
  const now = new Date();
  if (rows.length) {
    await InventoryItem.bulkWrite(
      rows.map((r) => ({
        updateOne: { filter: { storeId: store._id, itemId: r.itemId }, update: { $set: { ...r, lastSyncedAt: now } }, upsert: true },
      })),
    );
  }
  // was active here but eBay no longer lists it as active (ended elsewhere, or older than the 60-day lists)
  const gone = await InventoryItem.updateMany(
    { storeId: store._id, status: "active", $or: [{ lastSyncedAt: { $lt: now } }, { lastSyncedAt: null }] },
    { $set: { status: "ended", quantityAvailable: 0 } },
  );
  const { lowStockThreshold } = await inventorySettings(store._id);
  const low = await InventoryItem.countDocuments({ storeId: store._id, status: "active", quantityAvailable: { $lte: lowStockThreshold } });
  return {
    summary: `Inventory: ${active.length} active (${low} low/out of stock), ${unsold.length} unsold, ${sold.length} sold` +
      (gone.modifiedCount ? `, ${gone.modifiedCount} ended` : ""),
  };
}

/** Active listings with available quantity <= the store's threshold (includes out of stock). */
export async function inventoryCounts(store: StoreDocument): Promise<Counts> {
  const { lowStockThreshold } = await inventorySettings(store._id);
  return { lowStock: await InventoryItem.countDocuments({ storeId: store._id, status: "active", quantityAvailable: { $lte: lowStockThreshold } }) };
}
