/** One document per eBay order per store (Fulfillment API getOrders), normalized for lists + the raw JSON. */
import { Schema, model, type InferSchemaType, type Types } from "mongoose";

/** Our own simplified status, derived from eBay's payment / fulfillment / cancel states (see normalize.ts). */
export const ORDER_STATUSES = ["awaiting_payment", "awaiting_shipment", "shipped", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const money = { type: Number, default: 0 };

const lineItemSchema = new Schema(
  {
    lineItemId: { type: String, required: true },
    itemId: { type: String, default: "" },
    title: { type: String, default: "" },
    sku: { type: String, default: "" },
    qty: { type: Number, default: 1 },
    price: money,
    total: money,
    image: { type: String, default: "" },
    fulfillmentStatus: { type: String, default: "" },
  },
  { _id: false },
);

const fulfillmentSchema = new Schema(
  {
    fulfillmentId: { type: String, default: "" },
    carrier: { type: String, default: "" },
    trackingNumber: { type: String, default: "" },
    shippedDate: { type: Date, default: null },
    lineItems: [{ lineItemId: String, qty: Number, _id: false }],
  },
  { _id: false },
);

const refundSchema = new Schema(
  {
    refundId: { type: String, default: "" },
    amount: money,
    currency: { type: String, default: "USD" },
    date: { type: Date, default: null },
    status: { type: String, default: "" },
    reason: { type: String, default: "" },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    orderId: { type: String, required: true },
    legacyOrderId: { type: String, default: "" },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    paymentStatus: { type: String, default: "" },
    fulfillmentStatus: { type: String, default: "" },
    cancelState: { type: String, default: "" },
    buyer: {
      username: { type: String, default: "" },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
    },
    shipTo: {
      name: { type: String, default: "" },
      line1: { type: String, default: "" },
      line2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      postalCode: { type: String, default: "" },
      country: { type: String, default: "" },
      phone: { type: String, default: "" },
    },
    lineItems: { type: [lineItemSchema], default: [] },
    totals: {
      subtotal: money,
      shipping: money,
      tax: money,
      discount: money,
      total: money,
      currency: { type: String, default: "USD" },
    },
    /** eBay's marketplace fee for the order, when the API reports it (null = unknown) */
    fees: { type: Number, default: null },
    shippingService: { type: String, default: "" },
    shipByDate: { type: Date, default: null },
    buyerNotes: { type: String, default: "" },
    fulfillments: { type: [fulfillmentSchema], default: [] },
    refunds: { type: [refundSchema], default: [] },
    creationDate: { type: Date, required: true },
    lastModifiedDate: { type: Date, required: true },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false },
);
orderSchema.index({ storeId: 1, orderId: 1 }, { unique: true });
orderSchema.index({ storeId: 1, status: 1, shipByDate: 1 });
orderSchema.index({ storeId: 1, creationDate: -1 });

export const Order = model("Order", orderSchema);
export type OrderDoc = InferSchemaType<typeof orderSchema> & { _id: Types.ObjectId };
