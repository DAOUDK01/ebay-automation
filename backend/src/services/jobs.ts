import { Types } from "mongoose";
import { Job, type JobType } from "../models/Job";

/** Enqueue a job. sync/batch jobs are de-duplicated per store (one pending at a time). */
export async function enqueue(storeId: Types.ObjectId | string, type: JobType, payload: Record<string, unknown> = {}) {
  if (type === "sync" || type === "batch") {
    const existing = await Job.findOne({ storeId, type, status: { $in: ["queued", "running"] } });
    if (existing) return { job: existing, duplicate: true };
  }
  const job = await Job.create({ storeId, type, payload, status: "queued", runAt: new Date() });
  return { job, duplicate: false };
}

export async function cancelPending(storeId: Types.ObjectId | string) {
  await Job.updateMany(
    { storeId, status: { $in: ["queued", "running"] }, type: { $in: ["batch", "sync"] } },
    { $set: { status: "cancelled", finishedAt: new Date() } },
  );
}
