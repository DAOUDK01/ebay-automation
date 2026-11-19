import { Schema, model } from "mongoose";

/** Last background refresh of one module (orders, messages, ...) for one store. */
const syncStateSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    module: { type: String, required: true },
    lastRunAt: Date,
    lastSuccessAt: { type: Date, default: null },
    /** module-defined resume point, e.g. the last-modified date of the newest order seen */
    cursor: { type: Schema.Types.Mixed, default: null },
    summary: { type: String, default: "" },
    error: { type: String, default: "" },
  },
  { timestamps: true, minimize: false },
);
syncStateSchema.index({ storeId: 1, module: 1 }, { unique: true });

export const SyncState = model("SyncState", syncStateSchema);
