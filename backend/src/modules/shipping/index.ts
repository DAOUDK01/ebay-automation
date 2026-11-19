/**
 * Shipping hub: awaiting-shipment queue + tracking (uses the orders data), and "Policy fixes" - listings
 * whose shipping policy differs from the lib/shipping.ts suggestion, switched one by one on a user click.
 * No sync of its own: orders come from the orders module.
 */
import { Order } from "../orders/model";
import type { AccountModule } from "../types";
import router from "./router";

const shipping: AccountModule = {
  key: "shipping",
  label: "Shipping",
  ready: true,
  scopes: ["https://api.ebay.com/oauth/api_scope/sell.fulfillment"],
  router,
  counts: async (store) => ({ awaitingShipment: await Order.countDocuments({ storeId: store._id, status: "awaiting_shipment" }) }),
};

export default shipping;
