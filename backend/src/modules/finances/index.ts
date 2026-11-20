/**
 * Finances & payouts (read-only - eBay doesn't allow moving money by API):
 * Finances API getSellerFundsSummary / getPayouts / getTransactions, profit per order, monthly P&L, CSV export.
 *   client.ts  Finances API on apiz.ebay.com (reuses the account's token)
 *   models.ts  FundsSummary, Payout, FinTransaction
 *   logic.ts   pure mapping + profit / P&L / CSV maths
 *   sync.ts    incremental sync (cursor = newest payoutDate / transactionDate)
 *   routes.ts  API for the Finances page
 */
import type { AccountModule } from "../types";
import { FundsSummary } from "./models";
import router from "./routes";
import { syncFinances } from "./sync";

const finances: AccountModule = {
  key: "finances",
  label: "Finances",
  ready: true,
  scopes: ["https://api.ebay.com/oauth/api_scope/sell.finances"],
  router,
  sync: (ctx) => syncFinances(ctx),
  counts: async (store) => {
    const f = await FundsSummary.findOne({ storeId: store._id }).lean();
    return f ? { availableFunds: f.availableFunds, currency: f.currency } : { availableFunds: null };
  },
};

export default finances;
