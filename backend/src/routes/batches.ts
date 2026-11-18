import { Router } from "express";
import type { FitmentRow } from "../lib/ebay/types";
import { toCompatRows } from "../lib/fitment";
import { z } from "zod";
import { loadStore } from "../middleware/auth";
import { HttpError, parseBody } from "../middleware/error";
import { Batch } from "../models/Batch";
import { Proposal, PROPOSAL_STATUSES, type ProposalStatus } from "../models/Proposal";
import { enqueue } from "../services/jobs";
import { defaultDeps, recountBatch, revertProposal } from "../services/pipeline";

export const batchesRouter = Router({ mergeParams: true });
export const proposalsRouter = Router({ mergeParams: true });

const isId = (s: string) => /^[0-9a-f]{24}$/i.test(s);

batchesRouter.get("/", async (req, res) => {
  const store = await loadStore(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 20;
  const [items, total] = await Promise.all([
    Batch.find({ storeId: store._id }).sort({ number: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Batch.countDocuments({ storeId: store._id }),
  ]);
  res.json({ items, total, page, pageSize });
});

batchesRouter.get("/:batchId", async (req, res) => {
  const store = await loadStore(req);
  const batchId = String(req.params.batchId);
  if (!isId(batchId)) throw new HttpError(404, "Batch not found");
  const batch = await Batch.findOne({ _id: batchId, storeId: store._id }).lean();
  if (!batch) throw new HttpError(404, "Batch not found");
  const proposals = await Proposal.find({ batchId: batch._id }).sort({ _id: 1 }).lean();
  res.json({ batch, proposals });
});

batchesRouter.post("/:batchId/approve-all", async (req, res) => {
  const store = await loadStore(req);
  const batchId = String(req.params.batchId);
  if (!isId(batchId)) throw new HttpError(404, "Batch not found");
  const r = await Proposal.updateMany({ batchId, storeId: store._id, status: "proposed" }, { $set: { status: "approved" } });
  res.json({ approved: r.modifiedCount });
});

batchesRouter.post("/:batchId/push", async (req, res) => {
  const store = await loadStore(req);
  const batchId = String(req.params.batchId);
  if (!isId(batchId)) throw new HttpError(404, "Batch not found");
  const batch = await Batch.findOne({ _id: batchId, storeId: store._id });
  if (!batch) throw new HttpError(404, "Batch not found");
  const approved = await Proposal.countDocuments({ batchId: batch._id, status: "approved" });
  if (!approved) throw new HttpError(400, "No approved changes to push - approve some first");
  batch.status = "pushing";
  // reset live progress; the worker fills it in as it goes ("waiting for worker" until startedAt is set)
  batch.set("push", { total: approved, done: 0, failed: 0, currentItemId: "", startedAt: null, finishedAt: null });
  await batch.save();
  const { job } = await enqueue(store._id, "push", { batchId: String(batch._id) });
  res.status(202).json({ job, approved });
});

/** Re-run the listings of this batch that failed, as a new batch. */
batchesRouter.post("/:batchId/retry-errors", async (req, res) => {
  const store = await loadStore(req);
  const batchId = String(req.params.batchId);
  if (!isId(batchId)) throw new HttpError(404, "Batch not found");
  const failed = await Proposal.find({ batchId, storeId: store._id, status: "error" }).select("itemId").lean();
  const itemIds = [...new Set(failed.map((p) => p.itemId))];
  if (!itemIds.length) throw new HttpError(400, "This batch has no failed listings");
  const { job, duplicate } = await enqueue(store._id, "batch", { itemIds, trigger: "manual" });
  if (duplicate) throw new HttpError(409, "Another batch is already queued or running - try again when it finishes");
  res.status(202).json({ job, count: itemIds.length });
});

// ------------------------------------------------------------- proposals
const editSchema = z.object({
  status: z.enum(["approved", "rejected", "proposed"]).optional(),
  title: z.string().max(80).nullable().optional(),
  price: z.number().positive().nullable().optional(),
  /** true = push the vehicles the optimizer found (adds to eBay's list, never replaces); false = don't */
  pushCompatibility: z.boolean().optional(),
  /** true = switch the listing to the suggested shipping policy; false = keep the current one */
  pushShippingPolicy: z.boolean().optional(),
});

proposalsRouter.patch("/:proposalId", async (req, res) => {
  const store = await loadStore(req);
  const pid = String(req.params.proposalId);
  if (!isId(pid)) throw new HttpError(404, "Change not found");
  const body = parseBody(editSchema, req.body);
  const p = await Proposal.findOne({ _id: pid, storeId: store._id });
  if (!p) throw new HttpError(404, "Change not found");
  if (!["proposed", "approved", "rejected"].includes(p.status)) throw new HttpError(400, `Cannot edit a change that is ${p.status}`);
  const changes = { ...(p.changes as Record<string, unknown>) };
  if (body.title !== undefined) {
    const t = body.title?.replace(/\s+/g, " ").trim();
    if (t) changes.title = t;
    else delete changes.title;
  }
  if (body.price !== undefined) {
    if (body.price) changes.price = Math.round(body.price * 100) / 100;
    else delete changes.price;
  }
  if (body.pushCompatibility !== undefined) {
    const rows = ((p.suggestion as any)?.suggested_compatibility_rows ?? []) as FitmentRow[];
    if (body.pushCompatibility && rows.length) changes.compatibilityAdd = toCompatRows(rows);
    else delete changes.compatibilityAdd;
  }
  if (body.pushShippingPolicy !== undefined) {
    const sug = (p as any).shipping?.suggested;
    if (body.pushShippingPolicy && sug?.id) changes.shippingPolicyId = sug.id;
    else delete changes.shippingPolicyId;
  }
  p.changes = changes;
  p.markModified("changes");
  if (body.status) p.status = body.status;
  await p.save();
  if (p.batchId) await recountBatch(p.batchId as any);
  res.json({ proposal: p });
});

proposalsRouter.post("/:proposalId/revert", async (req, res) => {
  const store = await loadStore(req);
  const pid = String(req.params.proposalId);
  if (!isId(pid)) throw new HttpError(404, "Change not found");
  try {
    const p = await revertProposal(store, defaultDeps(store), pid);
    if (p.batchId) await recountBatch(p.batchId as any);
    res.json({ proposal: p });
  } catch (e: any) {
    throw new HttpError(400, e?.message ?? "Revert failed");
  }
});

/** Change history (everything pushed / failed / reverted) */
proposalsRouter.get("/", async (req, res) => {
  const store = await loadStore(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 25;
  const statuses = String(req.query.status || "pushed,reverted,failed")
    .split(",")
    .filter((s): s is ProposalStatus => (PROPOSAL_STATUSES as readonly string[]).includes(s));
  const filter = { storeId: store._id, status: { $in: statuses } };
  const [items, total] = await Promise.all([
    Proposal.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select("-competitors -before.descriptionText -before.compatibilitySample")
      .lean(),
    Proposal.countDocuments(filter),
  ]);
  res.json({ items, total, page, pageSize });
});
