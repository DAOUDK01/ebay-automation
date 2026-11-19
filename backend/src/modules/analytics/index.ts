/**
 * Analytics & account health (read-only): Analytics API getTrafficReport (by day and by listing),
 * getSellerStandardsProfile and customer-service metrics, stored as snapshots.
 *   models.ts  TrafficDay, ListingTraffic, AccountHealth
 *   logic.ts   report parsing + eBay thresholds
 *   sync.ts    refresh (always the last 30 complete days)
 *   routes.ts  API for the Analytics page
 */
import type { AccountModule } from "../types";
import { AccountHealth } from "./models";
import router from "./routes";
import { syncAnalytics } from "./sync";

const analytics: AccountModule = {
  key: "analytics",
  label: "Analytics",
  ready: true,
  scopes: ["https://api.ebay.com/oauth/api_scope/sell.analytics.readonly"],
  router,
  sync: (ctx) => syncAnalytics(ctx),
  counts: async (store) => {
    const h = await AccountHealth.findOne({ storeId: store._id }, { sellerLevel: 1 }).lean();
    return { sellerLevel: h?.sellerLevel ?? null };
  },
};

export default analytics;
