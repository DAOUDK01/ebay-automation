/** Background refresh: 30-day traffic by day and by listing, seller standards, customer-service metrics. */
import type { SyncContext, SyncResult } from "../types";
import {
  currentSellerLevel,
  isoDay,
  mapCustomerService,
  mapStandardsProfiles,
  parseTrafficReport,
  trafficQuery,
  trafficWindow,
} from "./logic";
import { AccountHealth, ListingTraffic, TrafficDay } from "./models";

/** per-listing traffic window */
export const WINDOW_DAYS = 30;
/** daily traffic kept: enough to compare a 90-day range with the 90 days before it */
export const HISTORY_DAYS = 180;
/** days per traffic_report call (eBay accepts up to 90-day ranges) */
const CHUNK_DAYS = 90;
const CS_TYPES = ["ITEM_NOT_AS_DESCRIBED", "ITEM_NOT_RECEIVED"];
const DAY_MS = 86_400_000;

export async function syncAnalytics(ctx: SyncContext, now = new Date()): Promise<SyncResult> {
  const { sell } = ctx.clients;
  const storeId = ctx.store._id;
  const mp = ctx.store.marketplaceId || "EBAY_US";
  const { start, end } = trafficWindow(WINDOW_DAYS, now);

  // 1. traffic by day for the whole history (eBay revises recent days), in 90-day chunks
  const history = trafficWindow(HISTORY_DAYS, now);
  const days: ReturnType<typeof parseTrafficReport> = [];
  for (let s = history.start; s <= history.end; s = new Date(s.getTime() + CHUNK_DAYS * DAY_MS)) {
    const e = new Date(Math.min(s.getTime() + (CHUNK_DAYS - 1) * DAY_MS, history.end.getTime()));
    days.push(...parseTrafficReport(await sell.get("/sell/analytics/v1/traffic_report", trafficQuery("DAY", mp, s, e))));
  }
  if (days.length) {
    await TrafficDay.bulkWrite(
      days.map(({ key, ...m }) => ({ updateOne: { filter: { storeId, day: isoDay(key) }, update: { $set: m }, upsert: true } })),
    );
  }

  // 2. traffic by listing (snapshot replaced)
  const listings = parseTrafficReport(await sell.get("/sell/analytics/v1/traffic_report", trafficQuery("LISTING", mp, start, end)));
  const periodStart = isoDay(start.toISOString());
  const periodEnd = isoDay(end.toISOString());
  if (listings.length) {
    await ListingTraffic.bulkWrite(
      listings.map(({ key, ...m }) => ({
        updateOne: { filter: { storeId, itemId: key }, update: { $set: { ...m, periodStart, periodEnd } }, upsert: true },
      })),
    );
  }
  await ListingTraffic.deleteMany({ storeId, itemId: { $nin: listings.map((l) => l.key) } });

  // 3. seller standards
  const profiles = mapStandardsProfiles(await sell.get("/sell/analytics/v1/seller_standards_profile"));
  const sellerLevel = currentSellerLevel(profiles);

  // 4. customer-service metrics (not every account has them - 404/409 just means "not evaluated")
  const customerService: ReturnType<typeof mapCustomerService> = [];
  for (const type of CS_TYPES) {
    try {
      const r = await sell.get(`/sell/analytics/v1/customer_service_metric/${type}/CURRENT`, { evaluation_marketplace_id: mp });
      customerService.push(...mapCustomerService(type, r));
    } catch (e: any) {
      ctx.log(`customer service metric ${type} not available: ${e?.message ?? e}`);
    }
  }

  await AccountHealth.updateOne(
    { storeId },
    { $set: { sellerLevel, profiles, customerService, fetchedAt: new Date() } },
    { upsert: true },
  );

  const level = sellerLevel ? sellerLevel.replace(/_/g, " ").toLowerCase() : "unknown level";
  return {
    cursor: { lastDay: periodEnd },
    summary: `${new Set(days.map((d) => d.key)).size} days, ${listings.length} listings, ${level}`,
  };
}
