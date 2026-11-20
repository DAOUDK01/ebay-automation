/**
 * /api/stores/:storeId/messages - threads, mark read, reply, Claude drafts, reply templates.
 * Replies need `confirm: true` (sent only from the UI's confirm dialog after a click); drafts never send.
 */
import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { clientsFor } from "../../lib/ebay/sell";
import type { TradingClient } from "../../lib/ebay/trading";
import { loadStore } from "../../middleware/auth";
import { HttpError, parseBody } from "../../middleware/error";
import { Listing } from "../../models/Listing";
import { Proposal } from "../../models/Proposal";
import { resolveSettings, type StoreDocument } from "../../models/Store";
import { addUsage, monthSpend } from "../../models/Usage";
import { PostOrderCase } from "../returns/model";
import { draftReply, type DraftFn, type DraftInput } from "./draft";
import { Message, ReplyTemplate, threadIdOf, threadKeyFromId } from "./model";
import { enqueue } from "../../services/jobs";
import { env } from "../../config/env";
import { MessageNotify, notificationUrl, subscribe } from "./notifications";
import { repairBodies } from "./sync";
import { buildMarkReadXml, buildPartnerXml, buildRtqXml } from "./trading";

/** Swappable in tests (fake eBay, fake Claude). */
export const deps: { trading: (store: StoreDocument) => Pick<TradingClient, "call" | "getItem">; draft: DraftFn } = {
  trading: (store) => clientsFor(store).trading,
  draft: draftReply,
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------------------------
// Threads

/** ?unread=1 &q= &page= */
router.get("/threads", async (req, res) => {
  const store = await loadStore(req);
  // clean bodies saved by an older version right away (no eBay call); ones cut off too early are
  // downloaded again by a messages sync queued now rather than at the next scheduled one
  const repaired = await repairBodies(store._id);
  if (repaired.refetch) await enqueue(store._id, "account_sync", { trigger: "manual", modules: ["messages"] });
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 30));
  const match: Record<string, unknown> = { storeId: store._id };
  const q = String(req.query.q ?? "").trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    match.$or = [{ buyer: rx }, { itemTitle: rx }, { subject: rx }, { body: rx }, { itemId: q }];
  }
  const [out] = await Message.aggregate([
    { $match: match },
    { $sort: { receivedAt: -1 } },
    {
      $group: {
        _id: "$threadKey",
        buyer: { $first: "$buyer" },
        itemId: { $first: "$itemId" },
        itemTitle: { $max: "$itemTitle" },
        subject: { $first: "$subject" },
        lastBody: { $first: "$body" },
        lastDirection: { $first: "$direction" },
        lastAt: { $first: "$receivedAt" },
        lastReplied: { $first: "$replied" },
        count: { $sum: 1 },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$read", false] }] }, 1, 0] } },
      },
    },
    ...(req.query.unread === "1" ? [{ $match: { unread: { $gt: 0 } } }] : []),
    { $sort: { lastAt: -1 } },
    { $facet: { items: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }], total: [{ $count: "n" }] } },
  ]);
  const items = (out?.items ?? []).map((t: any) => ({
    id: threadIdOf(t._id),
    buyer: t.buyer,
    itemId: t.itemId,
    itemTitle: t.itemTitle ?? "",
    subject: t.subject,
    preview: String(t.lastBody ?? "").slice(0, 160),
    lastDirection: t.lastDirection,
    lastAt: t.lastAt,
    count: t.count,
    unread: t.unread,
    needsReply: t.lastDirection === "in" && !t.lastReplied,
  }));
  const unreadThreads = await Message.distinct("threadKey", { storeId: store._id, direction: "in", read: false });
  res.json({ items, total: out?.total?.[0]?.n ?? 0, page, pageSize, unreadThreads: unreadThreads.length });
});

async function threadMessages(store: StoreDocument, id: string) {
  const threadKey = threadKeyFromId(id);
  const messages = await Message.find({ storeId: store._id, threadKey }).sort({ receivedAt: 1, createdAt: 1 }).lean();
  if (!messages.length) throw new HttpError(404, "Conversation not found");
  return { threadKey, messages };
}

type Msg = Awaited<ReturnType<typeof threadMessages>>["messages"][number];

/** RTQ answers the buyer's latest question; otherwise message them as an order partner. */
export function replyTarget(messages: Msg[]): { mode: "rtq" | "partner"; parentId: string } {
  const inbound = messages.filter((m) => m.direction === "in");
  const last = inbound[inbound.length - 1];
  const parentId = last ? last.externalId || last.messageId : "";
  if (last && parentId && (last.messageType === "AskSellerQuestion" || last.source === "member_messages")) return { mode: "rtq", parentId };
  return { mode: "partner", parentId: "" };
}

function threadInfo(messages: Msg[]) {
  const first = messages[0];
  return {
    buyer: messages.find((m) => m.buyer)?.buyer ?? first.buyer,
    itemId: first.itemId,
    itemTitle: messages.map((m) => m.itemTitle).find(Boolean) ?? "",
    subject: messages.map((m) => m.subject).find(Boolean) ?? "",
  };
}

router.get("/threads/:id", async (req, res) => {
  const store = await loadStore(req);
  const id = String(req.params.id);
  const { messages } = await threadMessages(store, id);
  const info = threadInfo(messages);
  const [listing, cases] = await Promise.all([
    info.itemId ? Listing.findOne({ storeId: store._id, itemId: info.itemId }).select("itemId title price imageUrl sku").lean() : null,
    PostOrderCase.find({ storeId: store._id, buyer: info.buyer, ...(info.itemId ? { itemId: info.itemId } : {}) })
      .select("kind ebayId status open respondBy")
      .lean(),
  ]);
  res.json({
    thread: { id, ...info, unread: messages.filter((m) => m.direction === "in" && !m.read).length, reply: replyTarget(messages).mode },
    messages,
    listing,
    cases,
  });
});

router.post("/threads/:id/read", async (req, res) => {
  const store = await loadStore(req);
  const read = req.body?.read !== false;
  const { threadKey, messages } = await threadMessages(store, String(req.params.id));
  const targets = messages.filter((m) => m.direction === "in" && m.read !== read);
  await Message.updateMany({ _id: { $in: targets.map((m) => m._id) } }, { $set: { read } });
  const ids = targets.map((m) => m.messageId).filter(Boolean);
  let warning = "";
  if (ids.length) {
    try {
      for (let i = 0; i < ids.length; i += 10) await deps.trading(store).call("ReviseMyMessages", buildMarkReadXml(ids.slice(i, i + 10), read));
    } catch (e: any) {
      warning = `Saved here, but eBay wasn't updated: ${e?.message ?? e}`;
    }
  }
  res.json({ ok: true, updated: targets.length, threadKey, warning });
});

const replySchema = z.object({
  body: z.string().trim().min(1, "Write a message").max(2000, "eBay messages are limited to 2000 characters"),
  mode: z.enum(["rtq", "partner"]).optional(),
  subject: z.string().trim().max(100).optional(),
});

/** Pure: which Trading call and body a reply becomes. Exported for tests. */
export function buildReply(messages: Msg[], input: z.infer<typeof replySchema>): { call: string; xml: string; mode: "rtq" | "partner" } {
  const info = threadInfo(messages);
  const target = replyTarget(messages);
  const mode = input.mode ?? target.mode;
  if (mode === "rtq") {
    if (!target.parentId) throw new HttpError(400, "There's no buyer question to answer in this conversation - send it as an order message");
    return { call: "AddMemberMessageRTQ", mode, xml: buildRtqXml({ itemId: info.itemId, parentId: target.parentId, buyer: info.buyer, body: input.body }) };
  }
  if (!info.itemId) throw new HttpError(400, "This conversation isn't about an item, so eBay won't deliver an order message");
  const subject = input.subject || (info.subject ? (/^re:/i.test(info.subject) ? info.subject : `Re: ${info.subject}`) : `About item ${info.itemId}`);
  return { call: "AddMemberMessageAAQToPartner", mode, xml: buildPartnerXml({ itemId: info.itemId, buyer: info.buyer, subject, body: input.body }) };
}

router.post("/threads/:id/reply", async (req, res) => {
  const store = await loadStore(req);
  if (req.body?.confirm !== true) throw new HttpError(400, "Please confirm sending this message");
  const input = parseBody(replySchema, req.body);
  const { threadKey, messages } = await threadMessages(store, String(req.params.id));
  const reply = buildReply(messages, input);
  try {
    await deps.trading(store).call(reply.call, reply.xml);
  } catch (e: any) {
    throw new HttpError(502, `eBay didn't send it: ${e?.message ?? e}`);
  }
  const info = threadInfo(messages);
  const now = new Date();
  const sent = await Message.create({
    storeId: store._id,
    key: `app:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
    source: "app",
    threadKey,
    direction: "out",
    sender: store.ebayUserId,
    recipient: info.buyer,
    buyer: info.buyer,
    itemId: info.itemId,
    itemTitle: info.itemTitle,
    subject: input.subject ?? (info.subject ? `Re: ${info.subject}` : ""),
    body: input.body,
    bodyFetched: true,
    messageType: reply.mode === "rtq" ? "ResponseToASQQuestion" : "ContactTransactionPartner",
    read: true,
    receivedAt: now,
  });
  await Message.updateMany({ storeId: store._id, threadKey, direction: "in" }, { $set: { replied: true, read: true } });
  res.json({ ok: true, mode: reply.mode, message: sent.toObject() });
});

// ---------------------------------------------------------------------------------------------
// Claude draft

/** Loose read of the orders module's data (if it exists) - just the status fields useful in a reply. */
async function orderContext(store: StoreDocument, buyer: string, itemId: string): Promise<Record<string, unknown> | null> {
  const Order = mongoose.models.Order;
  if (!Order || !buyer) return null;
  try {
    const o: any = await Order.findOne({
      storeId: store._id,
      $or: [{ buyer }, { buyerUsername: buyer }, { "buyer.username": buyer }],
      ...(itemId ? { $and: [{ $or: [{ itemIds: itemId }, { "lineItems.legacyItemId": itemId }, { "lineItems.itemId": itemId }, { itemId }] }] } : {}),
    })
      .sort({ createdAt: -1 })
      .lean();
    if (!o) return null;
    const keys = ["orderId", "status", "orderFulfillmentStatus", "fulfillmentStatus", "orderPaymentStatus", "paymentStatus", "creationDate", "orderedAt", "paidAt", "shipByDate", "shippedAt", "deliveredAt", "tracking", "trackingNumbers", "carrier", "total"];
    return Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k, o[k]]));
  } catch {
    return null;
  }
}

/** Listing facts: our last optimizer snapshot of it, else a live GetItem, else just the title. */
async function listingContext(store: StoreDocument, itemId: string, fallbackTitle: string): Promise<Record<string, unknown> | null> {
  if (!itemId) return null;
  const listing = await Listing.findOne({ storeId: store._id, itemId }).lean();
  const proposal = await Proposal.findOne({ storeId: store._id, itemId, "before.title": { $exists: true } }).sort({ createdAt: -1 }).lean();
  let item: any = proposal?.before ?? null;
  if (!item) {
    try {
      item = await deps.trading(store).getItem(itemId);
    } catch {
      item = null;
    }
  }
  if (!item && !listing) return fallbackTitle ? { itemId, title: fallbackTitle } : null;
  const compat: any[] = item?.compatibilityAll ?? item?.compatibilitySample ?? [];
  return {
    itemId,
    title: item?.title ?? listing?.title ?? fallbackTitle,
    price: item?.price ?? listing?.price,
    condition: item?.condition,
    conditionDescription: item?.conditionDescription || undefined,
    itemSpecifics: item?.itemSpecifics,
    compatibility: compat.slice(0, 80),
    compatibilityTotal: compat.length,
    handlingDays: item?.shipping?.dispatchDays,
    quantityAvailable: item ? Math.max(0, (item.quantity ?? 0) - (item.quantitySold ?? 0)) : undefined,
    description: item?.descriptionText ? String(item.descriptionText).slice(0, 1500) : undefined,
  };
}

export async function buildDraftInput(store: StoreDocument, messages: Msg[], instructions?: string): Promise<DraftInput> {
  const info = threadInfo(messages);
  const [listing, order, cases] = await Promise.all([
    listingContext(store, info.itemId, info.itemTitle),
    orderContext(store, info.buyer, info.itemId),
    PostOrderCase.find({ storeId: store._id, buyer: info.buyer, ...(info.itemId ? { itemId: info.itemId } : {}) })
      .select("kind status open reason respondBy amount")
      .lean(),
  ]);
  return {
    storeName: store.name,
    sellerId: store.ebayUserId,
    buyer: info.buyer,
    thread: messages.slice(-12).map((m) => ({
      from: m.direction === "in" ? "buyer" : "seller",
      at: m.receivedAt ? new Date(m.receivedAt).toISOString() : null,
      subject: m.subject ?? "",
      body: String(m.body ?? "").slice(0, 3000),
    })),
    listing,
    order,
    returns: cases.map((c) => ({ kind: c.kind, status: c.status, open: c.open, reason: c.reason, amount: c.amount })),
    ...(instructions?.trim() ? { instructions: instructions.trim().slice(0, 500) } : {}),
  };
}

router.post("/threads/:id/draft", async (req, res) => {
  const store = await loadStore(req);
  const { instructions } = parseBody(z.object({ instructions: z.string().max(500).optional() }), req.body ?? {});
  const { messages } = await threadMessages(store, String(req.params.id));
  const s = resolveSettings(store.settings);
  if ((await monthSpend(store._id)) >= s.claude.monthlyBudgetUsd) {
    throw new HttpError(402, `Monthly Claude budget $${s.claude.monthlyBudgetUsd} reached - raise it in Settings`);
  }
  const input = await buildDraftInput(store, messages, instructions);
  let r;
  try {
    r = await deps.draft(input, { model: s.claude.model, inputPricePerMtok: s.claude.inputPricePerMtok, outputPricePerMtok: s.claude.outputPricePerMtok });
  } catch (e: any) {
    if (e?.costUsd) await addUsage(store._id, e.costUsd, 0, 0);
    throw new HttpError(502, `Claude couldn't draft a reply: ${e?.message ?? e}`);
  }
  await addUsage(store._id, r.costUsd, r.inputTokens, r.outputTokens);
  res.json({ text: r.text.slice(0, 2000), costUsd: r.costUsd });
});

// ---------------------------------------------------------------------------------------------
// Instant messages (eBay push notifications)

router.get("/notifications", async (req, res) => {
  const store = await loadStore(req);
  const st = await MessageNotify.findOne({ storeId: store._id }).lean();
  res.json({
    enabled: Boolean(st?.enabledAt && !st.error),
    enabledAt: st?.enabledAt ?? null,
    error: st?.error ?? "",
    url: notificationUrl(),
    lastNotificationAt: st?.lastNotificationAt ?? null,
    notifications: st?.notifications ?? 0,
    signaturesVerified: Boolean(env.ebay.devId),
  });
});

/** Subscribe (again) now - e.g. after reconnecting or if eBay reported an error. */
router.post("/notifications/enable", async (req, res) => {
  const store = await loadStore(req);
  const r = await subscribe(store._id, deps.trading(store));
  if (!r.ok) throw new HttpError(502, r.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Reply templates

const templateSchema = z.object({ name: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(2000) });

router.get("/templates", async (req, res) => {
  const store = await loadStore(req);
  res.json({ templates: await ReplyTemplate.find({ storeId: store._id }).sort({ name: 1 }).lean() });
});

router.post("/templates", async (req, res) => {
  const store = await loadStore(req);
  const t = await ReplyTemplate.create({ storeId: store._id, ...parseBody(templateSchema, req.body) });
  res.status(201).json({ template: t.toObject() });
});

const templateId = (v: unknown) => {
  const id = String(v ?? "");
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new HttpError(404, "Template not found");
  return id;
};

router.patch("/templates/:tid", async (req, res) => {
  const store = await loadStore(req);
  const t = await ReplyTemplate.findOneAndUpdate(
    { _id: templateId(req.params.tid), storeId: store._id },
    { $set: parseBody(templateSchema.partial(), req.body) },
    { new: true },
  ).lean();
  if (!t) throw new HttpError(404, "Template not found");
  res.json({ template: t });
});

router.delete("/templates/:tid", async (req, res) => {
  const store = await loadStore(req);
  const r = await ReplyTemplate.deleteOne({ _id: templateId(req.params.tid), storeId: store._id });
  if (!r.deletedCount) throw new HttpError(404, "Template not found");
  res.json({ ok: true });
});

export default router;
