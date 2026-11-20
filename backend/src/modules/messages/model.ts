/**
 * Buyer messages (one row per message) and saved reply templates.
 * A thread = all messages with the same buyer + item (`threadKey`).
 */
import { Schema, model, type InferSchemaType } from "mongoose";

const messageSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    /** dedupe key: eBay's ExternalMessageID / member-message id (same message seen by both sync calls) */
    key: { type: String, required: true },
    /** GetMyMessages MessageID (needed for ReviseMyMessages); "" for member-message-only rows */
    messageId: { type: String, default: "" },
    /** id used as ParentMessageID when answering a question */
    externalId: { type: String, default: "" },
    source: { type: String, enum: ["my_messages", "member_messages", "app"], default: "my_messages" },
    threadKey: { type: String, required: true },
    direction: { type: String, enum: ["in", "out"], default: "in" },
    sender: { type: String, default: "" },
    recipient: { type: String, default: "" },
    buyer: { type: String, default: "" },
    itemId: { type: String, default: "" },
    itemTitle: { type: String, default: "" },
    subject: { type: String, default: "" },
    body: { type: String, default: "" },
    bodyFetched: { type: Boolean, default: false },
    /** AskSellerQuestion, ResponseToASQQuestion, ContactTransactionPartner, ... */
    messageType: { type: String, default: "" },
    questionType: { type: String, default: "" },
    read: { type: Boolean, default: false },
    replied: { type: Boolean, default: false },
    flagged: { type: Boolean, default: false },
    responseEnabled: { type: Boolean, default: false },
    receivedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);
messageSchema.index({ storeId: 1, key: 1 }, { unique: true });
messageSchema.index({ storeId: 1, threadKey: 1, receivedAt: 1 });
messageSchema.index({ storeId: 1, direction: 1, read: 1 });

export type MessageDoc = InferSchemaType<typeof messageSchema>;
export const Message = model("BuyerMessage", messageSchema);

const templateSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, index: true },
    name: { type: String, required: true },
    /** may contain {buyer} and {item} - filled in when the template is used */
    body: { type: String, required: true },
  },
  { timestamps: true },
);

export const ReplyTemplate = model("ReplyTemplate", templateSchema);

/** URL-safe thread id <-> threadKey ("buyer|itemId"). */
export const threadKeyOf = (buyer: string, itemId: string) => `${buyer.trim().toLowerCase()}|${itemId.trim()}`;
export const threadIdOf = (threadKey: string) => Buffer.from(threadKey, "utf8").toString("base64url");
export const threadKeyFromId = (id: string) => Buffer.from(id, "base64url").toString("utf8");
