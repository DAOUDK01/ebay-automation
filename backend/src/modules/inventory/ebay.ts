/**
 * Trading API calls for inventory: GetMyeBaySelling (active / unsold / sold lists), ReviseInventoryStatus,
 * RelistFixedPriceItem (RelistItem for auctions) and EndFixedPriceItem (EndItem for auctions).
 * Parsing is pure and tested; the HTTP side is the shared TradingClient.call.
 */
import type { TradingClient } from "../../lib/ebay/trading";
import { xmlEscape } from "../../lib/ebay/trading";
import type { InventoryStatus } from "./model";

export type Trading = Pick<TradingClient, "call">;

export const arr = <T = any>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);
export const txt = (v: any): string => {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
};
const num = (v: any) => Number(txt(v) || 0) || 0;
const date = (v: any) => {
  const d = txt(v) ? new Date(txt(v)) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

export interface StockRow {
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
  startTime: Date | null;
  endTime: Date | null;
}

/** <Item> from a GetMyeBaySelling list -> StockRow. */
export function parseSellingItem(it: any, status: InventoryStatus): StockRow {
  const priceEl = it.SellingStatus?.CurrentPrice ?? it.BuyItNowPrice ?? it.StartPrice;
  const quantity = num(it.Quantity);
  const sold = num(it.SellingStatus?.QuantitySold);
  const availableRaw = txt(it.QuantityAvailable);
  const available = availableRaw !== "" ? num(availableRaw) : Math.max(0, quantity - sold);
  return {
    itemId: txt(it.ItemID),
    title: txt(it.Title),
    sku: txt(it.SKU),
    imageUrl: txt(it.PictureDetails?.GalleryURL),
    url: txt(it.ListingDetails?.ViewItemURL),
    listingType: txt(it.ListingType),
    price: num(priceEl),
    currency: (priceEl && typeof priceEl === "object" && priceEl["@_currencyID"]) || "USD",
    quantity,
    quantityAvailable: status === "active" ? available : 0,
    quantitySold: sold,
    watchers: num(it.WatchCount),
    status,
    hasVariations: it.Variations !== undefined,
    startTime: date(it.ListingDetails?.StartTime),
    endTime: date(it.ListingDetails?.EndTime),
  };
}

/** Items in <SoldList>: each OrderTransaction holds a Transaction, or an Order with several. */
export function soldListItems(sold: any): any[] {
  const out: any[] = [];
  for (const ot of arr(sold?.OrderTransactionArray?.OrderTransaction)) {
    const txns = ot.Transaction ? arr(ot.Transaction) : arr(ot.Order?.TransactionArray?.Transaction);
    for (const t of txns) {
      const item = arr(t.Item)[0];
      if (item) out.push(item);
    }
  }
  return out;
}

type ListName = "ActiveList" | "UnsoldList" | "SoldList";
export const MAX_PAGES = 25;

/** Every row of one GetMyeBaySelling list (paged, 200 per page). */
export async function sellingList(t: Trading, list: ListName): Promise<StockRow[]> {
  const out: StockRow[] = [];
  const status: InventoryStatus = list === "ActiveList" ? "active" : list === "UnsoldList" ? "unsold" : "ended";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const root = await t.call(
      "GetMyeBaySelling",
      `<${list}><Include>true</Include>${list === "ActiveList" ? "" : "<DurationInDays>60</DurationInDays>"}` +
        `<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></${list}>` +
        `<DetailLevel>ReturnAll</DetailLevel>`,
    );
    const block = root[list];
    if (!block) break;
    const items = list === "SoldList" ? soldListItems(block) : arr(block.ItemArray?.Item);
    out.push(...items.map((it) => parseSellingItem(it, status)).filter((r) => r.itemId));
    const pages = num(block.PaginationResult?.TotalNumberOfPages);
    if (!items.length || page >= pages) break;
  }
  return out;
}

/** Merge the three lists into one row per item: active wins, then unsold, then ended (sold). */
export function mergeLists(active: StockRow[], unsold: StockRow[], sold: StockRow[]): StockRow[] {
  const byId = new Map<string, StockRow>();
  for (const r of sold) if (!byId.has(r.itemId)) byId.set(r.itemId, { ...r, status: "ended", quantityAvailable: 0 });
  for (const r of unsold) byId.set(r.itemId, { ...r, status: "unsold", quantityAvailable: 0 });
  for (const r of active) byId.set(r.itemId, r);
  return [...byId.values()];
}

// ---------------------------------------------------------------- writes

export interface StockChange {
  itemId: string;
  /** new quantity AVAILABLE (ReviseInventoryStatus sets available, not total listed) */
  quantity?: number;
  price?: number;
}
export interface ChangeResult extends StockChange {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

/** ReviseInventoryStatus takes at most 4 items per call. */
export const REVISE_BATCH = 4;
export const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export const reviseXml = (group: StockChange[]) =>
  group
    .map(
      (c) =>
        `<InventoryStatus><ItemID>${xmlEscape(c.itemId)}</ItemID>` +
        (c.quantity !== undefined ? `<Quantity>${Math.max(0, Math.floor(c.quantity))}</Quantity>` : "") +
        (c.price !== undefined ? `<StartPrice>${c.price.toFixed(2)}</StartPrice>` : "") +
        `</InventoryStatus>`,
    )
    .join("");

async function reviseGroup(t: Trading, group: StockChange[]): Promise<ChangeResult[]> {
  try {
    const root = await t.call("ReviseInventoryStatus", reviseXml(group), 1);
    const confirmed = new Set(arr(root.InventoryStatus).map((s: any) => txt(s.ItemID)));
    const warnings = arr(root.Errors).map((e: any) => txt(e.LongMessage)).filter(Boolean);
    return group.map((c) =>
      !confirmed.size || confirmed.has(c.itemId)
        ? { ...c, ok: true, ...(warnings.length ? { warnings } : {}) }
        : { ...c, ok: false, error: "eBay did not confirm this item" },
    );
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (group.length === 1) return [{ ...group[0], ok: false, error: msg }];
    // one bad item fails the whole call - send them one by one to find out which (setting qty/price is idempotent)
    const out: ChangeResult[] = [];
    for (const c of group) out.push(...(await reviseGroup(t, [c])));
    return out;
  }
}

/** Send quantity/price changes in groups of 4; one result per item, in input order. */
export async function reviseInventory(t: Trading, changes: StockChange[]): Promise<ChangeResult[]> {
  const out: ChangeResult[] = [];
  for (const group of chunk(changes, REVISE_BATCH)) out.push(...(await reviseGroup(t, group)));
  return out;
}

const isAuction = (listingType: string) => listingType === "Chinese";

/** Relist an ended item; returns the new item id. */
export async function relistItem(t: Trading, itemId: string, listingType = ""): Promise<string> {
  const call = isAuction(listingType) ? "RelistItem" : "RelistFixedPriceItem";
  const root = await t.call(call, `<Item><ItemID>${xmlEscape(itemId)}</ItemID></Item>`, 1);
  const newId = txt(root.ItemID);
  if (!newId) throw new Error(`${call} returned no new item id`);
  return newId;
}

export const END_REASONS = ["NotAvailable", "Incorrect", "LostOrBroken", "OtherListingError"] as const;
export type EndReason = (typeof END_REASONS)[number];

export async function endItem(t: Trading, itemId: string, reason: EndReason, listingType = ""): Promise<Date | null> {
  const call = isAuction(listingType) ? "EndItem" : "EndFixedPriceItem";
  const root = await t.call(call, `<ItemID>${xmlEscape(itemId)}</ItemID><EndingReason>${reason}</EndingReason>`, 1);
  return date(root.EndTime);
}
