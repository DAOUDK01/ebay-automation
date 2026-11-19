import { Schema, model } from "mongoose";

/** Simple MongoDB-backed job queue processed by the worker (src/worker.ts).
 *  Add new job types here as the product grows. */
export const JOB_TYPES = ["sync", "batch", "push", "account_sync"] as const;
export type JobType = (typeof JOB_TYPES)[number];

const jobSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, index: true },
    type: { type: String, enum: JOB_TYPES, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["queued", "running", "done", "failed", "cancelled"], default: "queued" },
    runAt: { type: Date, default: Date.now },
    lockedUntil: Date,
    lockedBy: String,
    attempts: { type: Number, default: 0 },
    startedAt: Date,
    finishedAt: Date,
    error: String,
    result: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, runAt: 1 });

export const Job = model("Job", jobSchema);
