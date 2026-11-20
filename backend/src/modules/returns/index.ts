/**
 * Returns, cancellations and cases: Post-Order API v2 (clients.postOrder).
 *  - model.ts   one collection for all three kinds
 *  - ebay.ts    eBay JSON -> rows, and the action payloads
 *  - sync.ts    background refresh (search endpoints, since a last-sync cursor)
 *  - router.ts  inbox, detail and confirm-gated actions
 * Post-Order uses the base api_scope every connected account already has.
 */
import type { StoreDocument } from "../../models/Store";
import type { AccountModule, Counts } from "../types";
import { PostOrderCase } from "./model";
import router from "./router";
import { syncReturns } from "./sync";

/** openReturns = open returns + cancellation requests (both need the seller); openCases = open cases. */
export async function returnsCounts(store: StoreDocument): Promise<Counts> {
  const [returns, cancels, cases] = await Promise.all([
    PostOrderCase.countDocuments({ storeId: store._id, kind: "return", open: true }),
    PostOrderCase.countDocuments({ storeId: store._id, kind: "cancellation", open: true }),
    PostOrderCase.countDocuments({ storeId: store._id, kind: "case", open: true }),
  ]);
  return { openReturns: returns + cancels, openCases: cases };
}

const returns: AccountModule = {
  key: "returns",
  label: "Returns & cases",
  ready: true,
  scopes: [],
  router,
  sync: syncReturns,
  counts: returnsCounts,
};

export default returns;
