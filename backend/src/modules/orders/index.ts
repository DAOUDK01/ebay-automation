/**
 * Orders & fulfillment: Fulfillment API getOrders (incremental), tracking upload (createShippingFulfillment), refunds (issueRefund), packing slips.
 * Not built yet - replace this stub with a real AccountModule (see ../types.ts) and set ready: true.
 * Keep everything for this module inside src/modules/orders/.
 */
import { stubModule } from "../stub";

export default stubModule("orders", "Orders", ["https://api.ebay.com/oauth/api_scope/sell.fulfillment"]);
