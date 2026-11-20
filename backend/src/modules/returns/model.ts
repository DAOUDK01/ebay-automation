/**
 * Returns, cancellations and cases (eBay Post-Order API) in one collection, so the inbox can list,
 * filter and sort them together. `kind` says which one a row is; `ebayId` is eBay's returnId /
 * cancelId / caseId.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

export const POST_ORDER_KINDS = ["return", "cancellation", "case"] as const;
export type PostOrderKind = (typeof POST_ORDER_KINDS)[number];

const amountSchema = new Schema({ value: Number, currency: String }, { _id: false });

const eventSchema = new Schema(
  {
    at: Date,
    /** BUYER | SELLER | SYSTEM | CS (eBay customer service) | APP (done from this app) */
    actor: { type: String, default: "SYSTEM" },
    action: { type: String, default: "" },
    text: { type: String, default: "" },
  },
  { _id: false },
);

const postOrderCaseSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    kind: { type: String, enum: POST_ORDER_KINDS, required: true },
    ebayId: { type: String, required: true },
    /** return: MONEY_BACK / REPLACEMENT; case: INR / SNAD / RETURN...; cancellation: who asked */
    type: { type: String, default: "" },
    /** eBay's coarse state (e.g. CLOSED) and detailed status (e.g. RETURN_REQUESTED) */
    state: { type: String, default: "" },
    status: { type: String, default: "" },
    open: { type: Boolean, default: true },
    buyer: { type: String, default: "" },
    itemId: { type: String, default: "" },
    itemTitle: { type: String, default: "" },
    orderId: { type: String, default: "" },
    transactionId: { type: String, default: "" },
    quantity: { type: Number, default: 1 },
    reason: { type: String, default: "" },
    comments: { type: String, default: "" },
    /** what the buyer is asking for (return refund estimate, cancel refund, case claim) */
    amount: { type: amountSchema, default: null },
    /** what was actually refunded, once known */
    refunded: { type: amountSchema, default: null },
    /** eBay deadline for the seller to act (null = nothing due from the seller) */
    respondBy: { type: Date, default: null },
    /** what eBay is waiting for from the seller, e.g. SELLER_APPROVE_REQUEST */
    dueAction: { type: String, default: "" },
    openedAt: { type: Date, default: null },
    ebayUpdatedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    /** history from eBay (detail calls) */
    timeline: { type: [eventSchema], default: [] },
    /** actions taken from this app (kept across syncs) */
    appActions: { type: [eventSchema], default: [] },
    raw: { type: Schema.Types.Mixed, default: null },
    detailRaw: { type: Schema.Types.Mixed, default: null },
    syncedAt: Date,
  },
  { timestamps: true, minimize: false },
);
postOrderCaseSchema.index({ storeId: 1, kind: 1, ebayId: 1 }, { unique: true });
postOrderCaseSchema.index({ storeId: 1, open: 1, respondBy: 1 });

export type PostOrderCaseDoc = InferSchemaType<typeof postOrderCaseSchema>;
export const PostOrderCase = model("PostOrderCase", postOrderCaseSchema);
