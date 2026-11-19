/**
 * Promotions: Marketing API - Promoted Listings Standard campaigns and their ads, item promotions (markdown sales).
 * Writes (create / pause / resume / end / add listings) only happen on a confirmed user click.
 *   models.ts  Campaign, Ad, ItemPromotion
 *   logic.ts   mapping + request bodies
 *   sync.ts    sync and the write actions
 *   routes.ts  API for the Promotions page
 */
import type { AccountModule } from "../types";
import { Campaign } from "./models";
import router from "./routes";
import { syncPromotions } from "./sync";

const promotions: AccountModule = {
  key: "promotions",
  label: "Promotions",
  ready: true,
  scopes: ["https://api.ebay.com/oauth/api_scope/sell.marketing"],
  router,
  sync: (ctx) => syncPromotions(ctx),
  counts: async (store) => ({ activeCampaigns: await Campaign.countDocuments({ storeId: store._id, status: "RUNNING" }) }),
};

export default promotions;
