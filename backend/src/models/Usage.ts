import { Schema, model, Types } from "mongoose";

const usageSchema = new Schema({
  storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
  month: { type: String, required: true }, // YYYY-MM (UTC)
  usd: { type: Number, default: 0 },
  calls: { type: Number, default: 0 },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
});
usageSchema.index({ storeId: 1, month: 1 }, { unique: true });

export const Usage = model("Usage", usageSchema);

export const currentMonth = () => new Date().toISOString().slice(0, 7);

export async function addUsage(storeId: Types.ObjectId, usd: number, inputTokens: number, outputTokens: number) {
  await Usage.updateOne(
    { storeId, month: currentMonth() },
    { $inc: { usd, calls: 1, inputTokens, outputTokens } },
    { upsert: true },
  );
}

export async function monthSpend(storeId: Types.ObjectId): Promise<number> {
  const u = await Usage.findOne({ storeId, month: currentMonth() }).lean();
  return u?.usd ?? 0;
}
