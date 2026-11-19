/** Finances data synced from eBay's Finances API (read-only: eBay doesn't allow moving money by API). */
import { Schema, model } from "mongoose";

/** Latest seller funds summary for one account. */
const fundsSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, unique: true },
    currency: { type: String, default: "USD" },
    totalFunds: { type: Number, default: 0 },
    availableFunds: { type: Number, default: 0 },
    processingFunds: { type: Number, default: 0 },
    fundsOnHold: { type: Number, default: 0 },
    fetchedAt: Date,
  },
  { timestamps: true },
);
export const FundsSummary = model("FinFundsSummary", fundsSchema);

const payoutSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    payoutId: { type: String, required: true },
    status: String, // INITIATED | SUCCEEDED | RETRYABLE_FAILED | TERMINAL_FAILED | REVERSED
    payoutDate: Date,
    lastAttemptedPayoutDate: Date,
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    instrument: { nickname: String, last4: String, type: { type: String } },
    transactionCount: { type: Number, default: 0 },
    memo: String,
  },
  { timestamps: true },
);
payoutSchema.index({ storeId: 1, payoutId: 1 }, { unique: true });
payoutSchema.index({ storeId: 1, payoutDate: -1 });
export const Payout = model("FinPayout", payoutSchema);

const lineSchema = new Schema(
  {
    lineItemId: String,
    itemId: String,
    quantity: { type: Number, default: 1 },
    title: String,
    feeBasis: { type: Number, default: 0 },
    fees: [{ _id: false, feeType: String, amount: Number, memo: String }],
  },
  { _id: false },
);

const transactionSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    transactionId: { type: String, required: true },
    type: { type: String, required: true }, // SALE | REFUND | CREDIT | DISPUTE | SHIPPING_LABEL | TRANSFER | NON_SALE_CHARGE ...
    status: String,
    date: { type: Date, required: true },
    bookingEntry: String, // CREDIT | DEBIT
    /** signed: money in > 0, money out < 0 (eBay's `amount` with bookingEntry applied) */
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    /** total eBay fees on this transaction (positive number) */
    feeTotal: { type: Number, default: 0 },
    feeBasis: { type: Number, default: 0 },
    /** for NON_SALE_CHARGE: e.g. AD_FEE, INSERTION_FEE */
    feeType: String,
    orderId: String,
    payoutId: String,
    buyer: String,
    memo: String,
    itemIds: [String],
    lines: [lineSchema],
    /** filled from the Fulfillment API when the sale's order could be read (item ids + quantities) */
    enriched: { type: Boolean, default: false },
  },
  { timestamps: true },
);
transactionSchema.index({ storeId: 1, transactionId: 1, type: 1 }, { unique: true });
transactionSchema.index({ storeId: 1, date: -1 });
transactionSchema.index({ storeId: 1, orderId: 1 });
transactionSchema.index({ storeId: 1, payoutId: 1 });
export const FinTransaction = model("FinTransaction", transactionSchema);
