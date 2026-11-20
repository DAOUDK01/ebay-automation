/** Types for the Inventory module (backend src/modules/inventory). */

export type InventoryStatus = "active" | "ended" | "unsold";
export type InventoryTab = "out" | "low" | "active" | "ended";

export interface InventoryItem {
  _id: string;
  itemId: string;
  title: string;
  sku: string;
  imageUrl: string;
  url: string;
  listingType: string;
  price: number;
  currency: string;
  quantity: number;
  quantityAvailable: number;
  quantitySold: number;
  watchers: number;
  status: InventoryStatus;
  hasVariations: boolean;
  startTime: string | null;
  endTime: string | null;
  relistedAs: string;
  lastSyncedAt: string | null;
}

export interface InventoryPage {
  items: InventoryItem[];
  total: number;
  page: number;
  pageSize: number;
  tabs: Record<InventoryTab, number>;
  lowStockThreshold: number;
}

export interface StockChange {
  itemId: string;
  quantity?: number;
  price?: number;
}

export interface ReviseResult extends StockChange {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

export const INVENTORY_TABS: { key: InventoryTab; label: string }[] = [
  { key: "out", label: "Out of stock" },
  { key: "low", label: "Low stock" },
  { key: "active", label: "All active" },
  { key: "ended", label: "Ended / unsold" },
];

export const END_REASONS = [
  { key: "NotAvailable", label: "No longer available" },
  { key: "Incorrect", label: "Listing has an error (price, title…)" },
  { key: "LostOrBroken", label: "Item lost or broken" },
  { key: "OtherListingError", label: "Other listing error" },
] as const;
export type EndReason = (typeof END_REASONS)[number]["key"];
