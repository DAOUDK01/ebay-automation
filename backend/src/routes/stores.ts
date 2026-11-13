import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { loadStore } from "../middleware/auth";
import { HttpError, parseBody } from "../middleware/error";
import { Batch } from "../models/Batch";
import { Job } from "../models/Job";
import { Listing } from "../models/Listing";
import { Proposal } from "../models/Proposal";
import { resolveSettings, Store, type StoreDocument } from "../models/Store";
import { currentMonth, Usage } from "../models/Usage";
import { cancelPending, enqueue } from "../services/jobs";
import { settingsSchema } from "./settingsSchema";

const router = Router();

async function storeStats(storeId: Types.ObjectId) {
  const [active, processed, never, pendingReview, usage] = await Promise.all([
    Listing.countDocuments({ storeId, active: true }),
    Listing.countDocuments({ storeId, active: true, lastProcessedAt: { $ne: null } }),
    Listing.countDocuments({ storeId, active: true, lastProcessedAt: null }),
    Proposal.countDocuments({ storeId, status: { $in: ["proposed", "approved"] } }),
    Usage.findOne({ storeId, month: currentMonth() }).lean(),
  ]);
  const pushedTotal = await Proposal.countDocuments({ storeId, status: "pushed" });
  return {
    activeListings: active,
    processedListings: processed,
    neverProcessed: never,
    pendingReview,
    pushedTotal,
    monthSpendUsd: usage?.usd ?? 0,
    monthCalls: usage?.calls ?? 0,
  };
}

function publicStore(store: StoreDocument) {
  return {
    id: String(store._id),
    name: store.name,
    ebayUserId: store.ebayUserId,
    marketplaceId: store.marketplaceId,
    settings: resolveSettings(store.settings),
    runner: store.runner,
    lastSyncAt: store.lastSyncAt,
    tokenExpiresAt: store.auth?.refreshTokenExpiresAt,
    createdAt: (store as any).createdAt,
  };
}

router.get("/", async (req, res) => {
  const stores = (await Store.find({ userId: req.userId }).sort({ createdAt: 1 })) as StoreDocument[];
  res.json({
    stores: await Promise.all(stores.map(async (s) => ({ ...publicStore(s), stats: await storeStats(s._id) }))),
  });
});

router.get("/:id", async (req, res) => {
  const store = await loadStore(req);
  const [stats, jobs, batches, usage] = await Promise.all([
    storeStats(store._id),
    Job.find({ storeId: store._id }).sort({ createdAt: -1 }).limit(10).lean(),
    Batch.find({ storeId: store._id }).sort({ number: -1 }).limit(5).lean(),
    Usage.find({ storeId: store._id }).sort({ month: -1 }).limit(6).lean(),
  ]);
  res.json({ store: { ...publicStore(store), stats }, jobs, batches, usage });
});

router.patch("/:id", async (req, res) => {
  const store = await loadStore(req);
  const body = parseBody(z.object({ name: z.string().min(1).max(80).optional(), settings: settingsSchema.optional() }), req.body);
  if (body.name) store.name = body.name;
  if (body.settings) {
    store.settings = body.settings as any;
    store.markModified("settings");
  }
  await store.save();
  res.json({ store: publicStore(store) });
});

router.delete("/:id", async (req, res) => {
  const store = await loadStore(req);
  await Promise.all([
    Listing.deleteMany({ storeId: store._id }),
    Proposal.deleteMany({ storeId: store._id }),
    Batch.deleteMany({ storeId: store._id }),
    Job.deleteMany({ storeId: store._id }),
    Usage.deleteMany({ storeId: store._id }),
  ]);
  await store.deleteOne();
  res.json({ ok: true });
});

router.post("/:id/sync", async (req, res) => {
  const store = await loadStore(req);
  const { job, duplicate } = await enqueue(store._id, "sync");
  res.status(202).json({ job, duplicate });
});

router.post("/:id/run", async (req, res) => {
  const store = await loadStore(req);
  const body = parseBody(
    z.object({ limit: z.number().int().min(1).max(200).optional(), itemIds: z.array(z.string()).max(200).optional() }),
    req.body ?? {},
  );
  const { job, duplicate } = await enqueue(store._id, "batch", { ...body, trigger: "manual" });
  res.status(202).json({ job, duplicate });
});

router.post("/:id/runner", async (req, res) => {
  const store = await loadStore(req);
  const { enabled } = parseBody(z.object({ enabled: z.boolean() }), req.body);
  store.runner.enabled = enabled;
  if (enabled) {
    store.runner.nextRunAt = new Date();
    store.runner.lastError = "";
  } else {
    await cancelPending(store._id);
  }
  await store.save();
  res.json({ runner: store.runner });
});

router.post("/:id/jobs/:jobId/cancel", async (req, res) => {
  const store = await loadStore(req);
  const job = await Job.findOneAndUpdate(
    { _id: req.params.jobId, storeId: store._id, status: { $in: ["queued", "running"] } },
    { $set: { status: "cancelled", finishedAt: new Date() } },
    { new: true },
  );
  if (!job) throw new HttpError(404, "No active job with that id");
  res.json({ job });
});

router.get("/:id/jobs", async (req, res) => {
  const store = await loadStore(req);
  res.json({ jobs: await Job.find({ storeId: store._id }).sort({ createdAt: -1 }).limit(50).lean() });
});

export default router;
