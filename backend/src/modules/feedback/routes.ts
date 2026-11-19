/** /api/stores/:storeId/feedback - list, summary, reply, leave, awaiting, settings. Every eBay write is a user click. */
import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { clientsFor } from "../../lib/ebay/sell";
import { loadStore } from "../../middleware/auth";
import { HttpError, parseBody } from "../../middleware/error";
import type { StoreDocument } from "../../models/Store";
import { MAX_TEXT, PERIODS, respondToFeedback, type PeriodCounts, type Trading } from "./ebay";
import { DEFAULT_AUTO_TEXT, Feedback, FeedbackAwaiting, feedbackSettings } from "./model";
import { leaveForAwaiting, localPeriods, needsReplyFilter } from "./service";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PAGE_SIZE = 25;
const text = z.string().trim().min(1, "Write a comment").max(MAX_TEXT, `eBay allows ${MAX_TEXT} characters`);

/** `trading` is injectable so tests can use a fake eBay. */
export function feedbackRouter(tradingFor: (store: StoreDocument) => Trading = (s) => clientsFor(s).trading) {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const store = await loadStore(req);
    const direction = req.query.direction === "left" ? "left" : "received";
    const rating = String(req.query.rating ?? "");
    const q = String(req.query.q ?? "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const filter: any =
      rating === "needs_reply" ? needsReplyFilter(store._id) : { storeId: store._id, direction };
    if (["positive", "neutral", "negative"].includes(rating)) filter.rating = rating[0].toUpperCase() + rating.slice(1);
    if (q) {
      const rx = { $regex: esc(q), $options: "i" };
      filter.$or = [{ user: rx }, { comment: rx }, { itemTitle: rx }, { itemId: q }];
    }
    const [items, total] = await Promise.all([
      Feedback.find(filter).sort({ date: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      Feedback.countDocuments(filter),
    ]);
    res.json({ items, total, page, pageSize: PAGE_SIZE });
  });

  router.get("/summary", async (req, res) => {
    const store = await loadStore(req);
    const [settings, local, needsReply, awaiting] = await Promise.all([
      feedbackSettings(store._id),
      localPeriods(store._id),
      Feedback.countDocuments(needsReplyFilter(store._id)),
      FeedbackAwaiting.countDocuments({ storeId: store._id }),
    ]);
    // eBay's own numbers where it sent them (its history goes further back than what we've synced)
    const ebay = (settings.profile?.periods ?? {}) as Partial<PeriodCounts>;
    const periods = Object.fromEntries(PERIODS.map((p) => [p, { ...(ebay[p] ?? local[p]), source: ebay[p] ? "ebay" : "synced" }]));
    res.json({
      periods,
      score: settings.profile?.score ?? null,
      positivePercent: settings.profile?.positivePercent ?? null,
      star: settings.profile?.star ?? "",
      profileUpdatedAt: settings.profile?.updatedAt ?? null,
      needsReply,
      awaiting,
      settings: { autoPositive: settings.autoPositive, autoText: settings.autoText },
    });
  });

  router.get("/awaiting", async (req, res) => {
    const store = await loadStore(req);
    const items = await FeedbackAwaiting.find({ storeId: store._id }).sort({ endTime: -1 }).limit(500).lean();
    res.json({ items, total: items.length });
  });

  /** Leave positive feedback for one or more buyers (the page asks for confirmation first). */
  router.post("/leave", async (req, res) => {
    const store = await loadStore(req);
    const body = parseBody(z.object({ ids: z.array(z.string()).min(1).max(200), text }), req.body);
    const ids = body.ids.filter((id) => Types.ObjectId.isValid(id));
    const rows = await FeedbackAwaiting.find({ storeId: store._id, _id: { $in: ids } }).lean();
    const trading = tradingFor(store);
    const results: { id: string; buyer: string; itemId: string; ok: boolean; error?: string }[] = [];
    for (const id of body.ids) {
      const row = rows.find((r) => String(r._id) === id);
      if (!row) {
        results.push({ id, buyer: "", itemId: "", ok: false, error: "Not awaiting feedback any more" });
        continue;
      }
      try {
        await leaveForAwaiting(trading, store._id, row, body.text);
        results.push({ id, buyer: row.buyer, itemId: row.itemId, ok: true });
      } catch (e: any) {
        results.push({ id, buyer: row.buyer, itemId: row.itemId, ok: false, error: String(e?.message ?? e) });
      }
    }
    res.json({ results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });

  router.get("/settings", async (req, res) => {
    const store = await loadStore(req);
    const s = await feedbackSettings(store._id);
    res.json({ settings: { autoPositive: s.autoPositive, autoText: s.autoText } });
  });

  router.put("/settings", async (req, res) => {
    const store = await loadStore(req);
    const body = parseBody(z.object({ autoPositive: z.boolean().optional(), autoText: text.optional() }), req.body);
    const s = await feedbackSettings(store._id);
    if (body.autoPositive !== undefined) s.autoPositive = body.autoPositive;
    if (body.autoText !== undefined) s.autoText = body.autoText || DEFAULT_AUTO_TEXT;
    await s.save();
    res.json({ settings: { autoPositive: s.autoPositive, autoText: s.autoText } });
  });

  /** Public reply to feedback a buyer left (confirmed on the page). */
  router.post("/:id/reply", async (req, res) => {
    const store = await loadStore(req);
    const body = parseBody(z.object({ text }), req.body);
    if (!Types.ObjectId.isValid(req.params.id)) throw new HttpError(404, "Feedback not found");
    const fb = await Feedback.findOne({ _id: req.params.id, storeId: store._id });
    if (!fb) throw new HttpError(404, "Feedback not found");
    if (fb.direction !== "received") throw new HttpError(400, "You can only reply to feedback you received");
    if (fb.response) throw new HttpError(400, "You already replied to this feedback");
    await respondToFeedback(tradingFor(store), {
      feedbackId: fb.feedbackId,
      itemId: fb.itemId,
      transactionId: fb.transactionId,
      targetUser: fb.user,
      text: body.text,
    });
    fb.response = body.text;
    fb.respondedAt = new Date();
    await fb.save();
    res.json({ feedback: fb });
  });

  return router;
}
