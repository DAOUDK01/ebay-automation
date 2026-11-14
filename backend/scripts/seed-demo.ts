/**
 * Local demo data so the UI can be explored without connecting a real eBay account.
 *   npm run seed:demo
 * Login:  demo@listing-optimizer.test  /  demo-password-123
 * Refuses to run against anything but a local MongoDB.
 */
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { encrypt } from "../src/lib/crypto";
import { Batch } from "../src/models/Batch";
import { Listing } from "../src/models/Listing";
import { Proposal } from "../src/models/Proposal";
import { DEFAULT_SETTINGS, Store } from "../src/models/Store";
import { User } from "../src/models/User";
import { Usage, currentMonth } from "../src/models/Usage";

const DEMO_EMAIL = "demo@listing-optimizer.test";
const DEMO_PASSWORD = "demo-password-123";

const PRODUCTS = [
  ["Front Ceramic Brake Pad Set Honda Civic 2016-2021", 38.99],
  ["Rear Brake Rotors Pair Toyota Camry 2018-2023", 74.5],
  ["Engine Air Filter Ford F-150 2015-2020 5.0L", 16.95],
  ["Cabin Air Filter Activated Carbon Chevy Silverado", 12.49],
  ["LED Headlight Bulbs H11 6000K Pair", 29.99],
  ["Oxygen Sensor Upstream Nissan Altima 2.5L", 34.0],
  ["Ignition Coil Pack Set of 4 Hyundai Elantra", 59.9],
  ["Serpentine Belt Tensioner Jeep Wrangler 3.6L", 42.75],
  ["Wheel Hub Bearing Assembly Front Subaru Outback", 68.0],
  ["Windshield Wiper Blades 26+16 Pair", 19.99],
  ["Radiator Coolant Overflow Tank BMW 3 Series", 27.5],
  ["Spark Plugs Iridium Set of 6 Toyota Tacoma", 44.99],
] as const;

async function main() {
  if (env.isProd || !/127\.0\.0\.1|localhost/.test(env.mongoUri)) {
    throw new Error("seed:demo only runs against a local MongoDB (MONGODB_URI must be localhost).");
  }
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });

  let user = await User.findOne({ email: DEMO_EMAIL });
  if (!user) user = await User.create({ email: DEMO_EMAIL, name: "Demo Seller", passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10) });

  // wipe previous demo store data
  const old = await Store.find({ userId: user._id });
  for (const s of old) {
    await Promise.all([
      Listing.deleteMany({ storeId: s._id }),
      Proposal.deleteMany({ storeId: s._id }),
      Batch.deleteMany({ storeId: s._id }),
      Usage.deleteMany({ storeId: s._id }),
    ]);
  }
  await Store.deleteMany({ userId: user._id });

  const store = await Store.create({
    userId: user._id,
    ebayUserId: "demo_parts_outlet",
    name: "Demo Parts Outlet",
    auth: { refreshTokenEnc: encrypt("demo-not-a-real-token"), scopes: [] },
    settings: { ...structuredClone(DEFAULT_SETTINGS), excludeSeller: "demo_parts_outlet" },
    runner: { enabled: false, lastError: "" },
    lastSyncAt: new Date(),
  });

  const now = Date.now();
  const listings = await Listing.insertMany(
    PRODUCTS.map(([title, price], i) => ({
      storeId: store._id,
      itemId: String(256100000000 + i),
      title,
      sku: `DPO-${1000 + i}`,
      price,
      quantitySold: (i * 7) % 23,
      watchCount: (i * 3) % 11,
      listingType: "FixedPriceItem",
      active: true,
      lastSyncedAt: new Date(),
      lastProcessedAt: i < 5 ? new Date(now - i * 3600_000) : null,
      cost: i % 3 === 0 ? Math.round(price * 0.45 * 100) / 100 : null,
    })),
  );

  const batch = await Batch.create({
    storeId: store._id,
    number: 1,
    status: "review",
    mode: "review",
    trigger: "manual",
    startedAt: new Date(now - 3 * 3600_000),
    finishedAt: new Date(now - 3 * 3600_000 + 10 * 60_000),
    costUsd: 0.27,
    counts: { total: 5, processed: 5, proposed: 3, noChange: 1, errors: 0, pushed: 1, failed: 0 },
  });

  const snap = (l: (typeof listings)[number]) => ({
    itemId: l.itemId,
    title: l.title,
    price: l.price,
    currency: "USD",
    categoryName: "Car & Truck Parts",
    condition: "New",
    imageUrl: "",
    url: `https://www.ebay.com/itm/${l.itemId}`,
    itemSpecifics: { Brand: ["Unbranded"], Placement: ["Front"] },
  });
  const p = (i: number, status: string, changes: object, extra: object = {}) => ({
    storeId: store._id,
    batchId: batch._id,
    itemId: listings[i].itemId,
    status,
    before: snap(listings[i]),
    changes,
    notes: ['competitor query: "demo" (12 found)', "title: ok"],
    costUsd: 0.054,
    suggestion: {
      title_reason: "Leads with brand + part type, adds fitment years buyers search for.",
      price_reason: "Closest matches sell for $35-$39 with free shipping.",
      confidence: "high",
    },
    ...extra,
  });
  await Proposal.insertMany([
    p(
      0,
      "proposed",
      { title: "2016-2021 Honda Civic Front Brake Pad Set Ceramic 45022-TBA-A01 OEM Used", price: 37.49 },
      {
        suggestion: {
          title_reason: "Follows the store format: years, brand, model, part & position, part number, OEM Used.",
          price_reason: "Closest matches sell for $35-$39 with free shipping.",
          confidence: "high",
          suggested_compatibility_rows: [
            ...["2016", "2017", "2018", "2019", "2020", "2021"].flatMap((y) =>
              ["EX Sedan 4-Door", "LX Sedan 4-Door", "Sport Hatchback 4-Door"].map((t) => ({
                Year: y, Make: "Honda", Model: "Civic", Trim: t, Engine: "2.0L 1996CC l4 GAS DOHC Naturally Aspirated",
                _source: "ebay_listings", _support: "3",
              })),
            ),
            { Year: "2022", Make: "Honda", Model: "Civic", _source: "part_number_knowledge", _support: "" },
            { Year: "2016", Make: "Acura", Model: "ILX", _source: "part_number_knowledge", _support: "" },
          ],
        },
        fitment: {
          partNumbers: ["45022-TBA-A01"],
          references: [
            { itemId: "325511223344", title: "16-21 Honda Civic Front Brake Pads OEM 45022-TBA-A01", url: "", partNumber: "45022-TBA-A01", rowCount: 54 },
            { itemId: "325599887766", title: "Genuine Honda 45022-TBA-A01 Front Pads Civic 2016-2021", url: "", partNumber: "45022-TBA-A01", rowCount: 48 },
            { itemId: "325577665544", title: "OEM Honda Civic brake pad set front 45022TBAA01", url: "", partNumber: "45022-TBA-A01", rowCount: 51 },
          ],
          dropped: ["2023 Honda Civic: part-number knowledge (medium confidence)", "2016 Honda Accord: not in eBay's vehicle catalog"],
          existingCount: 0,
        },
      },
    ),
    p(
      1,
      "proposed",
      {
        title: "Rear Brake Rotors Pair Fits Toyota Camry 2018-2023 Drilled Slotted",
        itemSpecifics: {
          Brand: ["Unbranded"],
          Placement: ["Rear"],
          "Manufacturer Part Number": ["DPO-1001"],
          "Interchange Part Number": ["42431-06190", "42431-33120"],
          "Rotor Design": ["Drilled & Slotted"],
          "Number of Pieces": ["2"],
        },
      },
      {
        suggestion: {
          title_reason: "Leads with part type and fitment years.",
          confidence: "high",
          item_specifics: [
            { name: "Manufacturer Part Number", values: ["DPO-1001"], source: "listing_text", confidence: "high" },
            { name: "Interchange Part Number", values: ["42431-06190", "42431-33120"], source: "part_number_knowledge", confidence: "high" },
            { name: "Rotor Design", values: ["Drilled & Slotted"], source: "other_listings", confidence: "high" },
            { name: "Number of Pieces", values: ["2"], source: "listing_text", confidence: "high" },
          ],
        },
      },
    ),
    p(2, "approved", { title: "Engine Air Filter for Ford F-150 2015-2020 5.0L V8 Replacement" }),
    p(3, "pushed", { title: "Cabin Air Filter with Activated Carbon for Chevy Silverado 1500 2014-2019" }, { pushedAt: new Date(now - 2 * 3600_000) }),
    p(4, "no_change", {}),
  ]);

  await Usage.create({ storeId: store._id, month: currentMonth(), usd: 3.42, calls: 61, inputTokens: 310000, outputTokens: 98000 });

  console.log(`Demo data ready. Sign in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e.message ?? e);
  await mongoose.disconnect();
  process.exit(1);
});
