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

export const WINDOW_DAYS = 30;
const CS_TYPES = ["ITEM_NOT_AS_DESCRIBED", "ITEM_NOT_RECEIVED"];

export async function syncAnalytics(ctx: SyncContext, now = new Date()): Promise<SyncResult> {
  const { sell } = ctx.clients;
  const storeId = ctx.store._id;
  const mp = ctx.store.marketplaceId || "EBAY_US";
  const { start, end } = trafficWindow(WINDOW_DAYS, now);

  // 1. traffic by day (always the whole window - eBay revises recent days)
  const days = parseTrafficReport(await sell.get("/sell/analytics/v1/traffic_report", trafficQuery("DAY", mp, start, end)));
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
    summary: `${days.length} days, ${listings.length} listings, ${level}`,
  };
}
