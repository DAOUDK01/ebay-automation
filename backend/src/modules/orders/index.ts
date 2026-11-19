/**
 * Orders & fulfillment: Fulfillment API getOrders (incremental by last-modified date), tracking upload
 * (createShippingFulfillment), refunds (issueRefund) and packing slips (rendered by the frontend).
 * Tracking and refunds only ever happen on a user click - never from sync.
 */
import type { AccountModule } from "../types";
import router from "./router";
import { orderCounts, syncOrders } from "./service";

const orders: AccountModule = {
  key: "orders",
  label: "Orders",
  ready: true,
  scopes: ["https://api.ebay.com/oauth/api_scope/sell.fulfillment"],
  router,
  sync: syncOrders,
  counts: orderCounts,
};

export default orders;
