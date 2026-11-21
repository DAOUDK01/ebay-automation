import { Schema, model } from "mongoose";

export const BATCH_STATUSES = ["running", "review", "pushing", "done", "error"] as const;

const batchSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, index: true },
    number: { type: Number, required: true },
    status: { type: String, enum: BATCH_STATUSES, default: "running" },
    mode: { type: String, enum: ["review", "auto"], required: true },
    trigger: { type: String, enum: ["schedule", "manual"], default: "manual" },
    /** the job that runs it + its listings: a job re-run after a worker restart continues this batch */
    jobId: { type: Schema.Types.ObjectId, default: null, index: true },
    itemIds: { type: [String], default: [] },
    startedAt: { type: Date, default: Date.now },
    finishedAt: Date,
    costUsd: { type: Number, default: 0 },
    counts: {
      total: { type: Number, default: 0 },
      processed: { type: Number, default: 0 },
      proposed: { type: Number, default: 0 },
      noChange: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      pushed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    error: String,
    /** live progress of the current/last push to eBay (shown as a progress bar) */
    push: {
      total: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      currentItemId: { type: String, default: "" },
      startedAt: Date,
      finishedAt: Date,
    },
  },
  { timestamps: true },
);
batchSchema.index({ storeId: 1, number: -1 });

export const Batch = model("Batch", batchSchema);
