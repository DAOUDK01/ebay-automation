/**
 * Demo data for Finances, Analytics and Promotions on the demo store from `npm run seed:demo`:
 * payouts and transactions with fee breakdowns (90 days), 30 days of traffic, account health, a campaign.
 *   npm run seed:demo && npm run seed:money-growth
 * Safe to re-run (replaces this data for the demo store). Refuses to run against anything but a local MongoDB.
 */
import mongoose, { type Types } from "mongoose";
import { env } from "../src/config/env";
import { Listing } from "../src/models/Listing";
import { Store } from "../src/models/Store";
import { SyncState } from "../src/models/SyncState";
import { AccountHealth, ListingTraffic, TrafficDay } from "../src/modules/analytics/models";
import { FinTransaction, FundsSummary, Payout } from "../src/modules/finances/models";
import { Ad, Campaign, ItemPromotion } from "../src/modules/promotions/models";

const DEMO_SELLER = "demo_parts_outlet";
const DAY = 86_400_000;

/** deterministic pseudo-random numbers so the demo looks the same every time */
let seed = 42;
const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const r2 = (n: number) => Math.round(n * 100) / 100;

async function wipe(storeId: Types.ObjectId) {
  await Promise.all(
    [FundsSummary, Payout, FinTransaction, TrafficDay, ListingTraffic, AccountHealth, Campaign, Ad, ItemPromotion].map((m: any) => m.deleteMany({ storeId })),
  );
  await SyncState.deleteMany({ storeId, module: { $in: ["finances", "analytics", "promotions"] } });
}

async function main() {
  if (env.isProd || !/127\.0\.0\.1|localhost/.test(env.mongoUri)) {
    throw new Error("seed:money-growth only runs against a local MongoDB (MONGODB_URI must be localhost).");
  }
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const store = await Store.findOne({ ebayUserId: DEMO_SELLER });
  if (!store) throw new Error("Demo store not found - run `npm run seed:demo` first.");
  const storeId = store._id as Types.ObjectId;
  await wipe(storeId);

  const listings = await Listing.find({ storeId }).sort({ itemId: 1 }).lean();
  if (!listings.length) throw new Error("Demo store has no listings - run `npm run seed:demo` first.");
  const now = Date.now();
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();

  // promoted listings: the first campaign promotes these
  const promoted = new Set([listings[0].itemId, listings[1].itemId, listings[8 % listings.length].itemId]);
  // these get plenty of views but no sales (for the analytics "views but no sales" list)
  const noSaleItems = new Set([listings[3 % listings.length].itemId, listings[10 % listings.length].itemId]);
  const sellable = listings.filter((l) => !noSaleItems.has(l.itemId));

  // ------------------------------------------------------------------ transactions (90 days)
  const txs: any[] = [];
  const salesPerDay = new Map<string, number>();
  const salesPerItem = new Map<string, number>();
  let n = 0;
  for (let d = 89; d >= 0; d--) {
    const orders = Math.floor(rnd() * 4) + (d % 7 === 1 ? 2 : 0);
    for (let k = 0; k < orders; k++) {
      const l = pick(sellable);
      const qty = rnd() < 0.15 ? 2 : 1;
      const date = new Date(today - d * DAY + (9 + rnd() * 11) * 3600_000);
      if (date.getTime() > now) continue;
      const orderId = `${String(10 + (n % 89)).padStart(2, "0")}-${String(13000 + n).padStart(5, "0")}-${String(40000 + n * 7).padStart(5, "0")}`;
      n++;
      const gross = r2((l.price ?? 20) * qty);
      const fvf = r2(gross * 0.1325);
      const fees = r2(fvf + 0.3);
      txs.push({
        transactionId: `SALE-${n}`,
        type: "SALE",
        status: "FUNDS_AVAILABLE_FOR_PAYOUT",
        date,
        bookingEntry: "CREDIT",
        amount: r2(gross - fees),
        currency: "USD",
        feeTotal: fees,
        feeBasis: gross,
        orderId,
        buyer: pick(["gearhead_88", "mike.t.garage", "sarah_k_auto", "dieselfixer", "civicfan2017", "brakeking", "j.romero", "tom_restores"]),
        itemIds: [l.itemId],
        lines: [
          {
            lineItemId: `${orderId}-L1`,
            itemId: l.itemId,
            quantity: qty,
            title: l.title,
            feeBasis: gross,
            fees: [
              { feeType: "FINAL_VALUE_FEE", amount: fvf },
              { feeType: "FINAL_VALUE_FEE_FIXED_PER_ORDER", amount: 0.3 },
            ],
          },
        ],
        enriched: true,
      });
      const day = date.toISOString().slice(0, 10);
      salesPerDay.set(day, (salesPerDay.get(day) ?? 0) + 1);
      salesPerItem.set(l.itemId, (salesPerItem.get(l.itemId) ?? 0) + 1);
      if (rnd() < 0.7) {
        txs.push({
          transactionId: `LABEL-${n}`,
          type: "SHIPPING_LABEL",
          status: "FUNDS_AVAILABLE_FOR_PAYOUT",
          date: new Date(date.getTime() + 5 * 3600_000),
          bookingEntry: "DEBIT",
          amount: -r2(5.5 + rnd() * 9),
          currency: "USD",
          orderId,
          itemIds: [l.itemId],
          memo: pick(["USPS Ground Advantage", "UPS Ground", "USPS Priority Mail"]),
        });
      }
      if (promoted.has(l.itemId) && rnd() < 0.6) {
        txs.push({
          transactionId: `ADFEE-${n}`,
          type: "NON_SALE_CHARGE",
          feeType: "AD_FEE",
          status: "FUNDS_AVAILABLE_FOR_PAYOUT",
          date: new Date(date.getTime() + 3600_000),
          bookingEntry: "DEBIT",
          amount: -r2(gross * 0.05),
          currency: "USD",
          orderId,
          itemIds: [l.itemId],
          memo: "Promoted Listings - General fee",
        });
      }
      if (rnd() < 0.05) {
        txs.push({
          transactionId: `REFUND-${n}`,
          type: "REFUND",
          status: "FUNDS_AVAILABLE_FOR_PAYOUT",
          date: new Date(date.getTime() + 4 * DAY),
          bookingEntry: "DEBIT",
          amount: -r2(rnd() < 0.5 ? gross : gross * 0.3),
          currency: "USD",
          orderId,
          buyer: "returns",
          itemIds: [l.itemId],
          memo: "Buyer return",
        });
      }
    }
  }
  txs.push({
    transactionId: "CREDIT-1",
    type: "CREDIT",
    status: "FUNDS_AVAILABLE_FOR_PAYOUT",
    date: new Date(today - 20 * DAY + 12 * 3600_000),
    bookingEntry: "CREDIT",
    amount: 4.5,
    currency: "USD",
    memo: "Final value fee credit",
  });
  txs.push({
    transactionId: "INSERTION-1",
    type: "NON_SALE_CHARGE",
    feeType: "INSERTION_FEE",
    status: "FUNDS_AVAILABLE_FOR_PAYOUT",
    date: new Date(today - 40 * DAY + 12 * 3600_000),
    bookingEntry: "DEBIT",
    amount: -3.6,
    currency: "USD",
    memo: "Insertion fees over the free allowance",
  });
  txs.sort((a, b) => a.date - b.date);

  // ------------------------------------------------------------------ weekly payouts (Tuesdays-ish), funds
  const payouts: any[] = [];
  let from = 0;
  for (let d = 84; d >= 2; d -= 7) {
    const payoutDate = new Date(today - d * DAY + 6 * 3600_000);
    const inIt = txs.filter((t) => t.date.getTime() >= from && t.date.getTime() < payoutDate.getTime() - DAY);
    from = payoutDate.getTime() - DAY;
    if (!inIt.length) continue;
    const payoutId = `PO-${payoutDate.toISOString().slice(0, 10).replace(/-/g, "")}`;
    for (const t of inIt) {
      t.payoutId = payoutId;
      t.status = "PAYOUT";
    }
    payouts.push({
      storeId,
      payoutId,
      status: d <= 2 ? "INITIATED" : "SUCCEEDED",
      payoutDate,
      amount: r2(inIt.reduce((s, t) => s + t.amount, 0)),
      currency: "USD",
      instrument: { nickname: "Business Checking", last4: "4821", type: "BANK" },
      transactionCount: inIt.length,
    });
  }
  const unpaid = txs.filter((t) => !t.payoutId);
  const processing = r2(unpaid.filter((t) => t.date.getTime() > now - 2 * DAY).reduce((s, t) => s + t.amount, 0));
  const available = r2(unpaid.filter((t) => t.date.getTime() <= now - 2 * DAY).reduce((s, t) => s + t.amount, 0));
  for (const t of unpaid) if (t.date.getTime() > now - 2 * DAY) t.status = "FUNDS_PROCESSING";
  await FinTransaction.insertMany(txs.map((t) => ({ storeId, ...t })));
  await Payout.insertMany(payouts);
  await FundsSummary.create({
    storeId,
    currency: "USD",
    availableFunds: available,
    processingFunds: processing,
    fundsOnHold: 38.99,
    totalFunds: r2(available + processing + 38.99),
    fetchedAt: new Date(),
  });

  // ------------------------------------------------------------------ traffic (30 complete days)
  const days: any[] = [];
  for (let d = 30; d >= 1; d--) {
    const day = new Date(today - d * DAY).toISOString().slice(0, 10);
    const impressions = Math.round(900 + rnd() * 700 + (30 - d) * 12);
    const views = Math.round(impressions * (0.03 + rnd() * 0.025));
    const transactions = salesPerDay.get(day) ?? 0;
    days.push({ storeId, day, impressions, views, transactions, ctr: r2((views / impressions) * 100), conversion: views ? r2((transactions / views) * 100) : 0 });
  }
  await TrafficDay.insertMany(days);
  const periodStart = days[0].day;
  const periodEnd = days.at(-1).day;
  await ListingTraffic.insertMany(
    listings.map((l, i) => {
      const noSale = noSaleItems.has(l.itemId);
      const impressions = Math.round((noSale ? 3200 : 600) + rnd() * 2400 - i * 40);
      const views = Math.round(impressions * (noSale ? 0.045 : 0.02 + rnd() * 0.03));
      const transactions = noSale ? 0 : Math.round((salesPerItem.get(l.itemId) ?? 0) / 3);
      return { storeId, itemId: l.itemId, impressions, views, transactions, ctr: r2((views / impressions) * 100), conversion: views ? r2((transactions / views) * 100) : 0, periodStart, periodEnd };
    }),
  );

  // ------------------------------------------------------------------ account health
  const evalDate = new Date(today - 0 * DAY).toISOString();
  await AccountHealth.create({
    storeId,
    sellerLevel: "TOP_RATED",
    profiles: [
      {
        program: "PROGRAM_US",
        level: "TOP_RATED",
        cycle: "CURRENT",
        evaluationDate: evalDate,
        evaluationReason: "Seller level generated by standards monthly evaluation cycle",
        defaultProgram: true,
        metrics: [
          { key: "DEFECTIVE_TRANSACTION_RATE", name: "Transaction defect rate", value: 0.31, numerator: 2, denominator: 642, level: "TOP_RATED", thresholdUpper: 0.5 },
          { key: "CLAIMS_SAF_RATE", name: "Cases closed without seller resolution", value: 0, numerator: 0, denominator: 642, level: "TOP_RATED", thresholdUpper: 0.3 },
          { key: "SHIPPING_MISS_RATE", name: "Late shipment rate", value: 1.4, numerator: 9, denominator: 642, level: "TOP_RATED", thresholdUpper: 3 },
          { key: "MIN_TXN_COUNT", name: "Transactions", value: 642, level: "TOP_RATED" },
        ],
      },
      {
        program: "PROGRAM_US",
        level: "TOP_RATED",
        cycle: "PROJECTED",
        evaluationDate: new Date(today + 15 * DAY).toISOString(),
        defaultProgram: true,
        metrics: [],
      },
    ],
    customerService: [
      { type: "ITEM_NOT_AS_DESCRIBED", dimension: "eBay Motors > Parts & Accessories", rate: 0.42, rating: "AVERAGE" },
      { type: "ITEM_NOT_RECEIVED", dimension: "eBay Motors > Parts & Accessories", rate: 0.11, rating: "LOW" },
    ],
    fetchedAt: new Date(),
  });

  // ------------------------------------------------------------------ promotions
  await Campaign.insertMany([
    {
      storeId,
      campaignId: "13567890011",
      name: "Brakes & bearings - Standard",
      status: "RUNNING",
      fundingModel: "COST_PER_SALE",
      bidPercentage: 5,
      marketplaceId: "EBAY_US",
      startDate: new Date(today - 60 * DAY),
      adCount: promoted.size,
    },
    {
      storeId,
      campaignId: "13567890007",
      name: "Summer filters",
      status: "ENDED",
      fundingModel: "COST_PER_SALE",
      bidPercentage: 3.5,
      marketplaceId: "EBAY_US",
      startDate: new Date(today - 150 * DAY),
      endDate: new Date(today - 70 * DAY),
      adCount: 2,
    },
  ]);
  await Ad.insertMany([
    ...[...promoted].map((itemId, i) => ({ storeId, campaignId: "13567890011", adId: `AD-11-${i}`, listingId: itemId, bidPercentage: i === 0 ? 6 : 5, status: "ACTIVE" })),
    { storeId, campaignId: "13567890007", adId: "AD-07-0", listingId: listings[2].itemId, bidPercentage: 3.5, status: "ARCHIVED" },
    { storeId, campaignId: "13567890007", adId: "AD-07-1", listingId: listings[3].itemId, bidPercentage: 3.5, status: "ARCHIVED" },
  ]);
  await ItemPromotion.insertMany([
    {
      storeId,
      promotionId: "5045012010",
      name: "15% off air & cabin filters",
      type: "MARKDOWN_SALE",
      status: "RUNNING",
      description: "15% off selected filters",
      startDate: new Date(today - 5 * DAY),
      endDate: new Date(today + 9 * DAY),
    },
    {
      storeId,
      promotionId: "5045012044",
      name: "Buy 2, save 10%",
      type: "VOLUME_DISCOUNT",
      status: "SCHEDULED",
      description: "Volume pricing on brake parts",
      startDate: new Date(today + 3 * DAY),
      endDate: new Date(today + 33 * DAY),
    },
    {
      storeId,
      promotionId: "5045011870",
      name: "Labor Day markdown",
      type: "MARKDOWN_SALE",
      status: "ENDED",
      startDate: new Date(today - 80 * DAY),
      endDate: new Date(today - 76 * DAY),
    },
  ]);

  // ------------------------------------------------------------------ sync status
  const at = new Date(now - 7 * 60_000);
  const sales = txs.filter((t) => t.type === "SALE").length;
  for (const [module, summary, cursor] of [
    ["finances", `${txs.length} transactions, ${payouts.length} payouts`, { payoutDate: payouts.at(-1)?.payoutDate?.toISOString(), transactionDate: txs.at(-1)?.date.toISOString() }],
    ["analytics", `30 days, ${listings.length} listings, top rated`, { lastDay: periodEnd }],
    ["promotions", "2 campaigns (1 running), 3 item promotions", null],
  ] as const) {
    await SyncState.updateOne({ storeId, module }, { $set: { lastRunAt: at, lastSuccessAt: at, summary, error: "", cursor } }, { upsert: true });
  }

  console.log(`Seeded ${sales} orders / ${txs.length} transactions, ${payouts.length} payouts, 30 traffic days, 2 campaigns for "${store.name}".`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
