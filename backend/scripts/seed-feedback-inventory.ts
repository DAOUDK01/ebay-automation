/**
 * Demo feedback + inventory for the demo store created by `npm run seed:demo` (run that first).
 *   npm run seed:feedback-inventory
 * Safe to re-run: replaces this store's feedback/inventory demo rows. Local MongoDB only.
 */
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { Listing } from "../src/models/Listing";
import { Store } from "../src/models/Store";
import { Feedback, FeedbackAwaiting, FeedbackSettings } from "../src/modules/feedback/model";
import { InventoryItem, InventorySettings } from "../src/modules/inventory/model";

const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const RECEIVED: [rating: string, days: number, user: string, comment: string, response?: string][] = [
  ["Positive", 0.5, "jake_garage", "Exactly as described, fast shipping. A+++"],
  ["Negative", 2, "rx_tuner88", "Part arrived with a cracked mounting tab. Not happy."],
  ["Positive", 3, "mila.k", "Fit my Civic perfectly. Great seller!"],
  ["Neutral", 6, "carl_parts", "Took a week to arrive, part is fine.", "Sorry for the wait - the carrier had delays that week."],
  ["Positive", 9, "dee_motors", "Genuine OEM part, well packed. Thank you"],
  ["Positive", 15, "tomas_v", "Great communication, would buy again."],
  ["Positive", 24, "lily_wrench", "Quick shipping and good price."],
  ["Positive", 45, "brake_bros", "Perfect fit, saved me a trip to the dealer."],
  ["Negative", 70, "angry_al", "Wrong part number.", "We refunded in full - the listing photo was mislabelled and is now fixed."],
  ["Positive", 120, "suzy_q", "Excellent seller."],
  ["Positive", 200, "hank_hill", "Works great."],
  ["Positive", 300, "otto_mech", "Fast and accurate."],
];

async function main() {
  if (env.isProd || !/127\.0\.0\.1|localhost/.test(env.mongoUri)) {
    throw new Error("This seed only runs against a local MongoDB (MONGODB_URI must be localhost).");
  }
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const store = await Store.findOne({ ebayUserId: "demo_parts_outlet" });
  if (!store) throw new Error("Demo store not found - run `npm run seed:demo` first.");
  const storeId = store._id;
  const listings = await Listing.find({ storeId }).sort({ itemId: 1 }).lean();
  if (!listings.length) throw new Error("Demo store has no listings - run `npm run seed:demo` first.");

  await Promise.all([
    Feedback.deleteMany({ storeId }),
    FeedbackAwaiting.deleteMany({ storeId }),
    FeedbackSettings.deleteMany({ storeId }),
    InventoryItem.deleteMany({ storeId }),
    InventorySettings.deleteMany({ storeId }),
  ]);

  // ---- feedback
  const pick = (i: number) => listings[i % listings.length];
  await Feedback.insertMany([
    ...RECEIVED.map(([rating, days, user, comment, response], i) => ({
      storeId,
      feedbackId: `demo-r${i}`,
      direction: "received",
      role: "Seller",
      rating,
      comment,
      user,
      userScore: 10 + i * 7,
      itemId: pick(i).itemId,
      itemTitle: pick(i).title,
      itemPrice: pick(i).price,
      transactionId: `demo-t${i}`,
      date: ago(days),
      response: response ?? "",
      respondedAt: response ? ago(days - 0.2) : null,
    })),
    ...["jake_garage", "mila.k", "dee_motors", "tomas_v"].map((user, i) => ({
      storeId,
      feedbackId: `demo-l${i}`,
      direction: "left",
      role: "Buyer",
      rating: "Positive",
      comment: "Great buyer, smooth transaction. Thank you!",
      user,
      itemId: pick(i).itemId,
      itemTitle: pick(i).title,
      itemPrice: pick(i).price,
      date: ago(1 + i * 4),
    })),
  ]);
  await FeedbackAwaiting.insertMany(
    ["pat_restores", "wheels4less", "nina_b"].map((buyer, i) => ({
      storeId,
      itemId: pick(i + 5).itemId,
      transactionId: `demo-await-${i}`,
      orderLineItemId: `${pick(i + 5).itemId}-demo-await-${i}`,
      buyer,
      title: pick(i + 5).title,
      imageUrl: pick(i + 5).imageUrl ?? "",
      endTime: ago(i + 1),
      lastSyncedAt: new Date(),
    })),
  );
  await FeedbackSettings.create({
    storeId,
    autoPositive: false,
    profile: { score: 1287, positivePercent: 99.4, star: "Turquoise", periods: null, updatedAt: new Date() },
  });

  // ---- inventory: varied stock on the demo listings, plus two ended ones
  const AVAILABLE = [0, 1, 4, 12, 0, 2, 25, 1, 8, 3, 50, 6];
  await InventoryItem.insertMany([
    ...listings.map((l, i) => {
      const available = AVAILABLE[i % AVAILABLE.length];
      return {
        storeId,
        itemId: l.itemId,
        title: l.title,
        sku: l.sku,
        imageUrl: l.imageUrl,
        url: `https://www.ebay.com/itm/${l.itemId}`,
        listingType: "FixedPriceItem",
        price: l.price,
        quantity: available + (l.quantitySold ?? 0),
        quantityAvailable: available,
        quantitySold: l.quantitySold ?? 0,
        watchers: l.watchCount ?? 0,
        status: "active",
        startTime: ago(30 + i),
        lastSyncedAt: new Date(),
      };
    }),
    {
      storeId, itemId: "256199990001", title: "Front Strut Assembly Pair Ford Focus 2012-2018", sku: "DPO-2001",
      listingType: "FixedPriceItem", price: 129.0, quantity: 2, quantityAvailable: 0, quantitySold: 0, watchers: 4,
      status: "unsold", startTime: ago(40), endTime: ago(10), lastSyncedAt: new Date(),
    },
    {
      storeId, itemId: "256199990002", title: "Fuel Pump Module Assembly Dodge Ram 1500 2009-2012", sku: "DPO-2002",
      listingType: "FixedPriceItem", price: 89.95, quantity: 3, quantityAvailable: 0, quantitySold: 3, watchers: 1,
      status: "ended", startTime: ago(50), endTime: ago(4), lastSyncedAt: new Date(),
    },
  ]);
  await InventorySettings.create({ storeId, lowStockThreshold: 1 });

  console.log(`Feedback + inventory demo data ready for "${store.name}".`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e.message ?? e);
  await mongoose.disconnect();
  process.exit(1);
});
