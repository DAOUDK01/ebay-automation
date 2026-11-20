/**
 * Inventory & relist: Trading GetMyeBaySelling (sync), ReviseInventoryStatus (bulk qty/price, 4 per call),
 * RelistFixedPriceItem and EndFixedPriceItem - writes only on a user click.
 */
import type { AccountModule } from "../types";
import { inventoryRouter } from "./routes";
import { inventoryCounts, syncInventory } from "./service";

const inventory: AccountModule = {
  key: "inventory",
  label: "Inventory",
  ready: true,
  scopes: [],
  router: inventoryRouter(),
  sync: syncInventory,
  counts: inventoryCounts,
};

export default inventory;
