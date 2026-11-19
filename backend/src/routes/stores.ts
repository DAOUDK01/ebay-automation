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
import { defaultDeps, getShippingPolicies } from "../services/pipeline";
import { renderAplus } from "../lib/description";
import { descriptionSchema, settingsSchema } from "./settingsSchema";
import { missingScopes, SCOPE_FEATURES } from "../lib/ebay/auth";
import { SyncState } from "../models/SyncState";
import { MODULES } from "../modules";
import { MODULE_KEYS } from "../modules/types";
import { countsFor, syncableModules } from "../services/accountSync";

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
    /** features this account can't use until it is reconnected (new eBay permissions) */
    missingFeatures: [...new Set(missingScopes(store.auth?.scopes).map((s) => SCOPE_FEATURES[s]).filter(Boolean))],
    createdAt: (store as any).createdAt,
  };
}

router.get("/", async (req, res) => {
  const stores = (await Store.find({ userId: req.userId }).sort({ createdAt: 1 })) as StoreDocument[];
  res.json({
    stores: await Promise.all(
      stores.map(async (s) => ({ ...publicStore(s), stats: await storeStats(s._id), counts: await countsFor(s) })),
    ),
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

/**
 * Start over: delete everything synced or produced for this store (listings, batches, proposals, jobs)
 * but keep the connected eBay account, its settings and this month's Claude spend (budget guard).
 * Nothing on eBay changes. Refused while the worker is busy with this store.
 */
router.post("/:id/reset", async (req, res) => {
  const store = await loadStore(req);
  const busy = await Job.exists({ storeId: store._id, status: "running", lockedUntil: { $gt: new Date() } });
  if (busy) throw new HttpError(409, "The worker is busy with this store right now - pause the runner, wait a minute and try again.");
  const [listings, proposals, batches, jobs] = await Promise.all([
    Listing.deleteMany({ storeId: store._id }),
    Proposal.deleteMany({ storeId: store._id }),
    Batch.deleteMany({ storeId: store._id }),
    Job.deleteMany({ storeId: store._id }),
  ]);
  await Store.updateOne(
    { _id: store._id },
    { $set: { "runner.enabled": false, "runner.lastError": "" }, $unset: { lastSyncAt: 1, "runner.nextRunAt": 1, "runner.lastBatchAt": 1 } },
  );
  res.json({
    ok: true,
    deleted: { listings: listings.deletedCount, proposals: proposals.deletedCount, batches: batches.deletedCount, jobs: jobs.deletedCount },
  });
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

/** The store's shipping policies with the weight bracket parsed from each name (Settings > Shipping). */
router.get("/:id/shipping-policies", async (req, res) => {
  const store = await loadStore(req);
  try {
    const policies = await getShippingPolicies(store, defaultDeps(store), req.query.refresh === "1");
    res.json({ policies });
  } catch (e: any) {
    throw new HttpError(502, `Couldn't load shipping policies from eBay: ${e?.message ?? e}`);
  }
});

/** Branded A+ description rendered with sample content and the given (possibly unsaved) branding. */
router.post("/:id/description-preview", async (req, res) => {
  const store = await loadStore(req);
  const brand = parseBody(descriptionSchema, req.body);
  const others: any[] = await Listing.find({ storeId: store._id, active: true, imageUrl: { $regex: "^https://" }, price: { $gt: 0 } })
    .select("itemId title price imageUrl quantitySold")
    .sort({ quantitySold: -1 })
    .limit(12)
    .lean();
  const withPhoto = others[0];
  const html = renderAplus({
    content: {
      headline: "Genuine Honda Civic Front Left Headlight",
      intro: "This is a used genuine Honda headlight assembly for the driver side, pulled from a 2018 Civic sedan. It is a direct OEM fit - no modifications needed.",
      highlights: [
        "Genuine OEM Honda part, not aftermarket",
        "Part number 33150-TBA-A01",
        "Front left (driver side) position",
        "Halogen type with all mounting tabs intact",
      ],
      fitment_summary: "Fits 2016-2021 Honda Civic sedan and coupe with halogen headlights. Please check the part number and the compatibility chart before buying.",
      condition_notes: "Used part in good working condition. Light surface scratches on the lens from normal use - see photos.",
      included: ["Headlight assembly only", "Bulbs not included"],
      install_tips: "Remove the front bumper cover to reach the headlight bolts.",
      faqs: [
        { q: "Will this fit my 2019 Civic hatchback?", a: "Yes, if your car has halogen headlights. LED-equipped trims use a different part - message us with your VIN to be sure." },
        { q: "Are the bulbs included?", a: "No, this is the headlight assembly only. You can move the bulbs over from your old unit." },
        { q: "Is this a genuine Honda part?", a: "Yes, it is a used genuine OEM Honda part, part number 33150-TBA-A01." },
      ],
    },
    title: "2016-2021 Honda Civic Front Left Headlight 33150-TBA-A01 OEM Used",
    condition: "Used",
    pictures: withPhoto?.imageUrl ? [withPhoto.imageUrl] : [],
    specifics: {
      Brand: ["Honda"],
      "Manufacturer Part Number": ["33150-TBA-A01"],
      "Interchange Part Number": ["33150TBAA01"],
      "Placement on Vehicle": ["Front", "Left"],
      "Headlight Style": ["Factory"],
      "Bulb Type": ["Halogen"],
    },
    compatibility: [2016, 2017, 2018, 2019, 2020, 2021].map((y) => ({ Year: String(y), Make: "Honda", Model: "Civic" })),
    currentHtml: "<p>Pulled from a 2018 Civic, 62k miles. Ships in 2 business days.</p>",
    brand,
    storeName: store.ebayUserId || store.name,
    sellerId: store.ebayUserId,
    price: 89.99,
    currency: "USD",
    related: others.slice(1, 1 + brand.relatedCount),
  });
  res.json({ html });
});

/** Sidebar badges / overview numbers from every built module (orders awaiting shipment, unread messages, ...). */
router.get("/:id/counts", async (req, res) => {
  const store = await loadStore(req);
  res.json({ counts: await countsFor(store) });
});

/** Background refresh status per module. */
router.get("/:id/account-sync", async (req, res) => {
  const store = await loadStore(req);
  const states = await SyncState.find({ storeId: store._id }).lean();
  const runnable = new Set(syncableModules(store).map((x) => x.module.key));
  res.json({
    lastScheduledAt: store.accountSyncAt ?? null,
    modules: MODULES.map((m) => {
      const st = states.find((x) => x.module === m.key);
      return {
        key: m.key,
        label: m.label,
        ready: m.ready,
        syncs: runnable.has(m.key),
        lastRunAt: st?.lastRunAt ?? null,
        lastSuccessAt: st?.lastSuccessAt ?? null,
        summary: st?.summary ?? "",
        error: st?.error ?? "",
      };
    }),
  });
});

/** Refresh now (all modules, or ?module=orders). */
router.post("/:id/account-sync", async (req, res) => {
  const store = await loadStore(req);
  const one = String(req.query.module ?? "");
  if (one && !(MODULE_KEYS as readonly string[]).includes(one)) throw new HttpError(400, "Unknown module");
  if (!syncableModules(store, one ? [one as any] : undefined).length) throw new HttpError(400, "Nothing to sync yet - these features are still being built");
  const { job, duplicate } = await enqueue(store._id, "account_sync", { trigger: "manual", ...(one ? { modules: [one] } : {}) });
  res.status(202).json({ job, duplicate });
});

router.get("/:id/jobs", async (req, res) => {
  const store = await loadStore(req);
  res.json({ jobs: await Job.find({ storeId: store._id }).sort({ createdAt: -1 }).limit(50).lean() });
});

export default router;
