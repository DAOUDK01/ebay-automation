/** Analytics snapshots: daily traffic, per-listing traffic and account health (seller standards, service metrics). */
import { Schema, model } from "mongoose";

const metrics = {
  impressions: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  /** eBay's CLICK_THROUGH_RATE / SALES_CONVERSION_RATE, as reported (percent) */
  ctr: { type: Number, default: null },
  conversion: { type: Number, default: null },
  transactions: { type: Number, default: 0 },
};

/** One account, one day (YYYY-MM-DD). Re-read every sync: eBay revises recent days. */
const trafficDaySchema = new Schema(
  { storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true }, day: { type: String, required: true }, ...metrics },
  { timestamps: true },
);
trafficDaySchema.index({ storeId: 1, day: 1 }, { unique: true });
export const TrafficDay = model("AnTrafficDay", trafficDaySchema);

/** Per-listing totals over the last sync window (replaced each sync). */
const listingTrafficSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    itemId: { type: String, required: true },
    ...metrics,
    periodStart: String,
    periodEnd: String,
  },
  { timestamps: true },
);
listingTrafficSchema.index({ storeId: 1, itemId: 1 }, { unique: true });
listingTrafficSchema.index({ storeId: 1, views: -1 });
export const ListingTraffic = model("AnListingTraffic", listingTrafficSchema);

const standardsMetric = new Schema(
  {
    key: String,
    name: String,
    /** percent (0.5 = 0.5%) or a count, see `key` */
    value: { type: Number, default: null },
    numerator: { type: Number, default: null },
    denominator: { type: Number, default: null },
    level: String,
    thresholdUpper: { type: Number, default: null },
    thresholdLower: { type: Number, default: null },
    lookbackStart: String,
    lookbackEnd: String,
  },
  { _id: false },
);

/** Latest account-health snapshot for one store. */
const healthSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, unique: true },
    sellerLevel: { type: String, default: null }, // TOP_RATED | ABOVE_STANDARD | BELOW_STANDARD
    profiles: [
      {
        _id: false,
        program: String,
        level: String,
        cycle: String, // CURRENT | PROJECTED
        evaluationDate: String,
        evaluationReason: String,
        defaultProgram: Boolean,
        metrics: [standardsMetric],
      },
    ],
    customerService: [
      {
        _id: false,
        type: { type: String }, // ITEM_NOT_AS_DESCRIBED | ITEM_NOT_RECEIVED
        dimension: String,
        rate: { type: Number, default: null },
        rating: String, // LOW | AVERAGE | HIGH | VERY_HIGH
        peerRate: { type: Number, default: null },
      },
    ],
    fetchedAt: Date,
  },
  { timestamps: true },
);
export const AccountHealth = model("AnAccountHealth", healthSchema);
