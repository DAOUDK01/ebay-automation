/** Background worker: schedules batches for stores with the runner switched on and executes queued jobs.
 *  Run it as its own process (npm run dev:worker / npm run start:worker). Safe to run several copies. */
import os from "os";
import { Types } from "mongoose";
import { env } from "./config/env";
import { connectDb } from "./db";
import { inActiveHours } from "./lib/guardrails";
import { logger, sleep } from "./lib/logger";
import { Batch } from "./models/Batch";
import { Job } from "./models/Job";
import { resolveSettings, Store, type StoreDocument } from "./models/Store";
import { monthSpend } from "./models/Usage";
import { enqueue } from "./services/jobs";
import { defaultDeps, pushProposals, runBatch, syncIfDue, syncListings } from "./services/pipeline";
import { runAccountSync, syncableModules } from "./services/accountSync";

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const LOCK_MS = 15 * 60_000;
let shuttingDown = false;

async function scheduleStores() {
  const now = new Date();
  const stores = (await Store.find({
    "runner.enabled": true,
    $or: [{ "runner.nextRunAt": null }, { "runner.nextRunAt": { $exists: false } }, { "runner.nextRunAt": { $lte: now } }],
  })) as StoreDocument[];
  for (const store of stores) {
    const s = resolveSettings(store.settings);
    if (!inActiveHours(s.activeHours, now)) {
      await Store.updateOne({ _id: store._id }, { $set: { "runner.nextRunAt": new Date(Date.now() + 15 * 60_000) } });
      continue;
    }
    if ((await monthSpend(store._id)) >= s.claude.monthlyBudgetUsd) {
      await Store.updateOne(
        { _id: store._id },
        { $set: { "runner.nextRunAt": new Date(Date.now() + 6 * 3600_000), "runner.lastError": "Monthly Claude budget reached" } },
      );
      continue;
    }
    await enqueue(store._id, "batch", { trigger: "schedule" });
    // placeholder; the real next run is set when the batch finishes
    await Store.updateOne({ _id: store._id }, { $set: { "runner.nextRunAt": new Date(Date.now() + s.gapBetweenBatchesMin * 60_000) } });
  }
}

/** Queue an account_sync for every store that is due (orders, messages, returns, finances...). */
async function scheduleAccountSync() {
  const stores = (await Store.find({})) as StoreDocument[];
  for (const store of stores) {
    const s = resolveSettings(store.settings);
    if (!s.accountSync.enabled || !syncableModules(store).length) continue;
    const due = !store.accountSyncAt || Date.now() - store.accountSyncAt.getTime() >= s.accountSync.everyMin * 60_000;
    if (!due) continue;
    await Store.updateOne({ _id: store._id }, { $set: { accountSyncAt: new Date() } });
    await enqueue(store._id, "account_sync", { trigger: "schedule" });
  }
}

async function claimJob() {
  const candidates = await Job.find({ status: "queued", runAt: { $lte: new Date() } }).sort({ runAt: 1 }).limit(20).lean();
  for (const c of candidates) {
    const busy = await Job.exists({ storeId: c.storeId, status: "running" });
    if (busy) continue;
    const job = await Job.findOneAndUpdate(
      { _id: c._id, status: "queued" },
      {
        $set: { status: "running", lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + LOCK_MS), startedAt: new Date() },
        $inc: { attempts: 1 },
      },
      { new: true },
    );
    if (job) return job;
  }
  return null;
}

async function runJob(job: InstanceType<typeof Job>) {
  const heartbeat = setInterval(() => {
    Job.updateOne({ _id: job._id, status: "running" }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MS) } }).catch(() => {});
  }, 60_000);
  const store = (await Store.findById(job.storeId)) as StoreDocument | null;
  try {
    if (!store) throw new Error("Store no longer exists");
    const deps = defaultDeps(store);
    const payload = (job.payload ?? {}) as any;
    let result: unknown = null;
    if (job.type === "sync") {
      result = { listings: await syncListings(store, deps) };
    } else if (job.type === "batch") {
      await syncIfDue(store, deps);
      const fresh = (await Store.findById(store._id)) as StoreDocument;
      const batch = await runBatch(fresh, deps, {
        limit: payload.limit,
        itemIds: payload.itemIds,
        trigger: payload.trigger ?? "manual",
        shouldStop: async () => (await Job.findById(job._id).select("status").lean())?.status === "cancelled",
      });
      result = { batchId: batch?._id ?? null, number: batch?.number ?? null };
      if (payload.trigger === "schedule") {
        const s = resolveSettings(fresh.settings);
        // nothing left to do -> check again in 6h, otherwise wait the normal gap
        const wait = batch ? s.gapBetweenBatchesMin * 60_000 : 6 * 3600_000;
        await Store.updateOne(
          { _id: store._id },
          { $set: { "runner.nextRunAt": new Date(Date.now() + wait), "runner.lastBatchAt": new Date(), "runner.lastError": "" } },
        );
      }
    } else if (job.type === "account_sync") {
      result = { runs: await runAccountSync(store, payload.modules) };
    } else if (job.type === "push") {
      await pushProposals(store, deps, new Types.ObjectId(String(payload.batchId)), ["approved"]);
      result = { batchId: payload.batchId };
    }
    await Job.updateOne(
      { _id: job._id, status: "running" },
      { $set: { status: "done", finishedAt: new Date(), result } },
    );
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    logger.error(`job ${job._id} (${job.type}) failed`, e);
    await Job.updateOne({ _id: job._id }, { $set: { status: "failed", finishedAt: new Date(), error: msg } });
    if (store && job.type !== "account_sync") {
      await Store.updateOne({ _id: store._id }, { $set: { "runner.lastError": msg, "runner.nextRunAt": new Date(Date.now() + 30 * 60_000) } });
      if (job.type === "push" && (job.payload as any)?.batchId) {
        await Batch.updateOne({ _id: (job.payload as any).batchId }, { $set: { status: "review", error: msg } });
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function recoverStaleJobs() {
  const r = await Job.updateMany(
    { status: "running", lockedUntil: { $lt: new Date() } },
    { $set: { status: "queued" }, $unset: { lockedBy: 1, lockedUntil: 1 } },
  );
  if (r.modifiedCount) logger.warn(`re-queued ${r.modifiedCount} stale job(s)`);
}

async function main() {
  await connectDb();
  logger.info(`worker ${WORKER_ID} started (poll ${env.workerPollSeconds}s)`);
  while (!shuttingDown) {
    try {
      await recoverStaleJobs();
      await scheduleStores();
      await scheduleAccountSync();
      let job;
      while (!shuttingDown && (job = await claimJob())) {
        logger.info(`running job ${job._id} type=${job.type} store=${job.storeId}`);
        await runJob(job);
      }
    } catch (e) {
      logger.error("worker tick failed", e);
    }
    await sleep(env.workerPollSeconds * 1000);
  }
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info(`${sig} received - worker will stop after the current job`);
    shuttingDown = true;
  });
}

main().catch((e) => {
  logger.error("worker crashed", e);
  process.exit(1);
});
