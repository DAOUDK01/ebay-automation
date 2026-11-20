/**
 * Demo duplicate listings for the demo store created by `npm run seed:demo` (run that first).
 *   npm run seed:duplicates
 * Adds three duplicate groups (same SKU, same title, same part number). Safe to re-run. Local MongoDB only.
 */
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { Listing } from "../src/models/Listing";
import { Store } from "../src/models/Store";

const img = (t: string) => `https://placehold.co/400x300/1f2937/ffffff/png?text=${encodeURIComponent(t)}`;

const DUPES = [
  // same title as an existing demo listing, twice
  { itemId: "256100000901", title: "Front Ceramic Brake Pad Set Honda Civic 2016-2021", price: 36.5, quantitySold: 0, watchCount: 1, sku: "", image: "Pads copy" },
  { itemId: "256100000902", title: "Front Ceramic Brake Pad Set Honda Civic 2016-2021", price: 39.99, quantitySold: 0, watchCount: 0, sku: "", image: "Pads copy 2" },
  // same SKU as a demo listing (DPO-1004), different wording
  { itemId: "256100000903", title: "H11 LED headlight bulbs pair 6000K white", price: 24.99, quantitySold: 1, watchCount: 2, sku: "DPO-1004", image: "H11 bulbs" },
  // same OEM part number in both titles
  { itemId: "256100000904", title: "2016-2021 Honda Civic Front Left Headlight 33150-TBA-A01 OEM Used", price: 189, quantitySold: 2, watchCount: 6, sku: "HL-TBA-1", image: "Headlight A" },
  { itemId: "256100000905", title: "Honda Civic driver side headlamp assembly 33150-TBA-A01", price: 175, quantitySold: 0, watchCount: 3, sku: "HL-TBA-2", image: "Headlight B" },
];

async function main() {
  if (env.isProd || !/127\.0\.0\.1|localhost/.test(env.mongoUri)) {
    throw new Error("This seed only runs against a local MongoDB (MONGODB_URI must be localhost).");
  }
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const store = await Store.findOne({ ebayUserId: "demo_parts_outlet" });
  if (!store) throw new Error("Demo store not found - run `npm run seed:demo` first.");
  for (const d of DUPES) {
    await Listing.updateOne(
      { storeId: store._id, itemId: d.itemId },
      {
        $set: {
          title: d.title,
          price: d.price,
          sku: d.sku,
          quantitySold: d.quantitySold,
          watchCount: d.watchCount,
          imageUrl: img(d.image),
          listingType: "FixedPriceItem",
          active: true,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  console.log(`Added ${DUPES.length} duplicate listings (3 groups) to "${store.name}".`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
