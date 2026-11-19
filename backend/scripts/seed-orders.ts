/**
 * Demo orders (and a few shipping-policy fixes) for the demo store made by `npm run seed:demo`.
 *   npm run seed:demo && npm run seed:orders
 * Re-running replaces the demo orders. Refuses to run against anything but a local MongoDB.
 */
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { Listing } from "../src/models/Listing";
import { Proposal } from "../src/models/Proposal";
import { Store } from "../src/models/Store";
import { User } from "../src/models/User";
import { normalizeOrder } from "../src/modules/orders/ebay";
import { Order } from "../src/modules/orders/model";

const DEMO_EMAIL = "demo@listing-optimizer.test";

const BUYERS = [
  ["mike_garage77", "Michael Turner", "48 Oak Ridge Dr", "Columbus", "OH", "43215"],
  ["jen.autofix", "Jennifer Lopez-Reyes", "1290 Sunset Blvd Apt 4", "Phoenix", "AZ", "85004"],
  ["truckguy_tx", "Dwayne Carter", "77 Ranch Rd", "Amarillo", "TX", "79101"],
  ["sam_k_motors", "Samantha King", "501 Pine St", "Seattle", "WA", "98101"],
  ["civicfan2016", "Kevin Nguyen", "33 Harbor Way", "San Diego", "CA", "92101"],
  ["oldschool_wrench", "Robert Miller", "9 Elm Ct", "Dayton", "OH", "45402"],
  ["bmw_restorer", "Anna Schmidt", "2100 Lakeview Ave", "Chicago", "IL", "60614"],
  ["jeep_trails_co", "Carlos Mendez", "15 Canyon Rd", "Denver", "CO", "80202"],
] as const;

const H = 3600_000;
const D = 24 * H;

async function main() {
  if (env.isProd || !/127\.0\.0\.1|localhost/.test(env.mongoUri)) {
    throw new Error("seed:orders only runs against a local MongoDB (MONGODB_URI must be localhost).");
  }
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const user = await User.findOne({ email: DEMO_EMAIL });
  const store = user && (await Store.findOne({ userId: user._id, ebayUserId: "demo_parts_outlet" }));
  if (!store) throw new Error("Demo store not found - run `npm run seed:demo` first.");
  const listings = await Listing.find({ storeId: store._id }).sort({ itemId: 1 }).lean();
  if (!listings.length) throw new Error("Demo store has no listings - run `npm run seed:demo` first.");

  await Order.deleteMany({ storeId: store._id });
  const now = Date.now();
  const iso = (ago: number) => new Date(now - ago).toISOString();

  // [age, payment, fulfillment, cancel, listing indexes, ship-by offset from creation]
  const plan: { age: number; pay?: string; ful?: string; cancel?: string; items: number[]; qty?: number[]; tracking?: [string, string] }[] = [
    { age: 2 * H, items: [0] },
    { age: 5 * H, items: [4, 9], qty: [1, 2] },
    { age: 9 * H, items: [2] },
    { age: 20 * H, items: [6] },
    { age: 1.6 * D, items: [8] },
    { age: 3.2 * D, items: [11] }, // overdue
    { age: 4.5 * D, items: [1], qty: [2] }, // overdue
    { age: 3 * H, pay: "PENDING", items: [3] },
    { age: 1.2 * D, ful: "FULFILLED", items: [5], tracking: ["USPS", "9400111899223817465012"] },
    { age: 2.1 * D, ful: "FULFILLED", items: [7], tracking: ["UPS", "1Z999AA10123456784"] },
    { age: 4 * D, ful: "FULFILLED", items: [10, 3], tracking: ["FedEx", "771234567890"] },
    { age: 6 * D, ful: "FULFILLED", items: [0], qty: [2], tracking: ["USPS", "9400111899223817465999"] },
    { age: 9 * D, ful: "FULFILLED", items: [9], tracking: ["UPS", "1Z999AA10123450000"] },
    { age: 2.5 * D, cancel: "CANCELED", pay: "FULLY_REFUNDED", items: [6] },
    { age: 8 * D, pay: "FULLY_REFUNDED", items: [2] },
  ];

  const docs = plan.map((p, n) => {
    const [username, name, line1, city, state, zip] = BUYERS[n % BUYERS.length];
    const orderId = `${10 + n}-${String(13000 + n * 37).padStart(5, "0")}-${String(40000 + n * 911).padStart(5, "0")}`;
    const created = now - p.age;
    const shipBy = new Date(created + 2 * D).toISOString();
    const lines = p.items.map((li, k) => {
      const l = listings[li % listings.length];
      const qty = p.qty?.[k] ?? 1;
      const cost = Math.round((l.price ?? 20) * qty * 100) / 100;
      return {
        lineItemId: `${orderId}-L${k + 1}`,
        legacyItemId: l.itemId,
        title: l.title,
        sku: l.sku,
        quantity: qty,
        lineItemCost: { value: cost.toFixed(2), currency: "USD" },
        total: { value: cost.toFixed(2), currency: "USD" },
        lineItemFulfillmentStatus: p.ful === "FULFILLED" ? "FULFILLED" : "NOT_STARTED",
        lineItemFulfillmentInstructions: { shipByDate: shipBy },
      };
    });
    const subtotal = lines.reduce((s, l) => s + Number(l.lineItemCost.value), 0);
    const ship = subtotal > 60 ? 0 : 8.95;
    const total = Math.round((subtotal + ship) * 100) / 100;
    const refunded = p.pay === "FULLY_REFUNDED";
    const raw = {
      orderId,
      legacyOrderId: `${256100000000 + n}-${2100000000 + n}`,
      creationDate: iso(p.age),
      lastModifiedDate: iso(Math.max(0, p.age - 2 * H)),
      orderPaymentStatus: p.pay ?? "PAID",
      orderFulfillmentStatus: p.ful ?? "NOT_STARTED",
      cancelStatus: { cancelState: p.cancel ?? "NONE_REQUESTED" },
      buyer: { username },
      buyerCheckoutNotes: n === 1 ? "Please double box, thanks!" : undefined,
      pricingSummary: {
        priceSubtotal: { value: subtotal.toFixed(2), currency: "USD" },
        deliveryCost: { value: ship.toFixed(2), currency: "USD" },
        total: { value: total.toFixed(2), currency: "USD" },
      },
      totalMarketplaceFee: { value: (total * 0.1325 + 0.4).toFixed(2), currency: "USD" },
      paymentSummary: {
        refunds: refunded ? [{ refundId: `RF-${n}`, amount: { value: total.toFixed(2), currency: "USD" }, refundDate: iso(p.age - 6 * H), refundStatus: "REFUNDED" }] : [],
      },
      fulfillmentStartInstructions: [
        {
          shippingStep: {
            shippingServiceCode: ship ? "USPSPriority" : "UPSGround",
            shipTo: {
              fullName: name,
              contactAddress: { addressLine1: line1, city, stateOrProvince: state, postalCode: zip, countryCode: "US" },
              primaryPhone: { phoneNumber: "5555550100" },
            },
          },
        },
      ],
      lineItems: lines,
    };
    const fulfillments = p.tracking
      ? [{ fulfillmentId: `F-${n}`, shippingCarrierCode: p.tracking[0], shipmentTrackingNumber: p.tracking[1], shippedDate: iso(p.age - 20 * H), lineItems: lines.map((l) => ({ lineItemId: l.lineItemId, quantity: l.quantity })) }]
      : [];
    const images = Object.fromEntries(listings.map((l) => [l.itemId, l.imageUrl ?? ""]));
    return { storeId: store._id, ...normalizeOrder(raw, images, fulfillments) };
  });
  await Order.insertMany(docs);

  // shipping analyses that disagree with the current policy -> "Policy fixes" tab
  await Proposal.deleteMany({ storeId: store._id, kind: "manual", "notes.0": /^demo shipping analysis/ });
  const pol = (id: string, name: string, kg: number) => ({ id, name, kg });
  const fixes = [
    [1, pol("P10", "Ground 10 KG", 10), pol("P5", "Ground 5 KG", 5), 4.2, "Current policy is 10 kg - item only needs 5 kg (buyers are overcharged)"],
    [8, pol("P3", "Ground 3 KG", 3), pol("P7", "Ground 7 KG", 7), 6.4, "Current policy is 3 kg - item needs 7 kg (you are undercharging)"],
    [10, pol("P5", "Ground 5 KG", 5), pol("P3", "Ground 3 KG", 3), 1.1, "Current policy is 5 kg - item only needs 3 kg (buyers are overcharged)"],
  ] as const;
  await Proposal.insertMany(
    fixes.map(([i, current, suggested, kg, note]) => ({
      storeId: store._id,
      batchId: null,
      kind: "manual",
      itemId: listings[i].itemId,
      status: "no_change",
      notes: ["demo shipping analysis"],
      shipping: {
        source: "listing", rule: "weight", actualKg: kg, dimensionalKg: kg, divisor: 5000, billableKg: kg,
        categoryKg: suggested.kg, overMax: false, package: { weightKg: kg, lengthCm: 30, widthCm: 20, heightCm: 15 },
        current, suggested, matches: false, note,
      },
    })),
  );

  console.log(`Seeded ${docs.length} demo orders and ${fixes.length} shipping policy fixes for "${store.name}".`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
