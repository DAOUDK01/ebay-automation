/** Background refresh of buyer messages: GetMyMessages (headers, then bodies of new ones) + GetMemberMessages. */
import type { Types } from "mongoose";
import type { TradingClient } from "../../lib/ebay/trading";
import type { SyncContext, SyncResult } from "../types";
import { Message } from "./model";
import { extractUserText, fetchBodies, fetchHeaders, fetchQuestions, isSystemSender, looksLikeRawEmail, type MappedMessage } from "./trading";

const DAY = 86_400_000;
export const FIRST_LOOKBACK_DAYS = 90;
/** bump when body extraction changes: GetMyMessages bodies saved by an older version are fetched again */
export const BODY_VERSION = 3;
/** re-read a day before the last sync so nothing slips between runs */
const OVERLAP_MS = DAY;
/** bodies fetched per run (10 per call) */
const MAX_BODIES = 300;

/** Upsert rows from either call; the two calls can see the same message (same key) and are merged. */
export async function upsertMessages(storeId: Types.ObjectId, rows: MappedMessage[]): Promise<number> {
  const keep = rows.filter((r) => r.key && !(r.direction === "in" && isSystemSender(r.sender)));
  if (!keep.length) return 0;
  const ops = keep.map((r) => {
    const { key, source, read, replied, itemTitle, subject, body, bodyFetched, messageId, ...rest } = r;
    const set: Record<string, unknown> = { ...rest };
    const onInsert: Record<string, unknown> = { source };
    // only fill text/ids when this call has them, never blank out what the other call saved
    if (messageId) set.messageId = messageId;
    if (itemTitle) set.itemTitle = itemTitle;
    if (subject) set.subject = subject;
    if (body) Object.assign(set, { body, bodyFetched: bodyFetched ?? true, bodyVersion: BODY_VERSION });
    if (source === "my_messages") {
      // GetMyMessages owns the read flag
      if (read !== undefined) set.read = read;
      if (replied !== undefined) set.replied = replied;
    } else {
      onInsert.read = r.direction === "out" || !!replied;
      if (replied) set.replied = true;
      else onInsert.replied = false;
    }
    return { updateOne: { filter: { storeId, key }, update: { $set: set, $setOnInsert: onInsert }, upsert: true } };
  });
  const res = await Message.bulkWrite(ops);
  return res.upsertedCount;
}

/**
 * Bodies saved by older versions: a body that still holds eBay's whole email (escaped HTML shown as text)
 * is re-extracted from what's stored - no eBay call needed; clean ones are just marked current.
 * Returns how many bodies were cleaned.
 */
export async function repairBodies(storeId: Types.ObjectId): Promise<number> {
  const old = await Message.find({ storeId, bodyVersion: { $lt: BODY_VERSION }, body: { $ne: "" } })
    .select("body bodyFetched")
    .lean();
  if (!old.length) return 0;
  let cleaned = 0;
  const ops = old.map((m) => {
    const set: Record<string, unknown> = { bodyVersion: BODY_VERSION };
    if (looksLikeRawEmail(m.body)) {
      const text = extractUserText(m.body).slice(0, 8000);
      set.body = text;
      if (!text) set.bodyFetched = false; // nothing usable kept: fetch it again
      cleaned++;
    }
    return { updateOne: { filter: { _id: m._id }, update: { $set: set } } };
  });
  await Message.bulkWrite(ops);
  return cleaned;
}

export async function fillBodies(storeId: Types.ObjectId, t: Pick<TradingClient, "call">): Promise<number> {
  const missing = await Message.find({
    storeId,
    messageId: { $ne: "" },
    bodyFetched: false,
  })
    .sort({ receivedAt: -1 })
    .limit(MAX_BODIES)
    .select("messageId")
    .lean();
  if (!missing.length) return 0;
  const bodies = await fetchBodies(t, missing.map((m) => m.messageId));
  if (!bodies.size) return 0;
  await Message.bulkWrite(
    [...bodies].map(([messageId, body]) => ({
      updateOne: { filter: { storeId, messageId }, update: { $set: { body, bodyFetched: true, bodyVersion: BODY_VERSION } } },
    })),
  );
  return bodies.size;
}

const SOURCE_RANK: Record<string, number> = { my_messages: 0, member_messages: 1, app: 2 };
const normBody = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);

/**
 * One reply can reach us three ways: the Sent folder, the question's <Response>, and the row this app
 * saved when sending. Keep one per thread + text (+ within 2 days), preferring the Sent-folder row.
 */
export async function dedupeOutbound(storeId: Types.ObjectId, sinceDays = 90): Promise<number> {
  const outs = await Message.find({ storeId, direction: "out", body: { $ne: "" }, receivedAt: { $gte: new Date(Date.now() - sinceDays * DAY) } })
    .sort({ receivedAt: 1 })
    .select("threadKey body source receivedAt")
    .lean();
  const kept = new Map<string, (typeof outs)[number][]>();
  const drop: Types.ObjectId[] = [];
  for (const o of outs) {
    const k = `${o.threadKey}|${normBody(o.body)}`;
    const list = kept.get(k) ?? [];
    const twin = list.find((p) => Math.abs((p.receivedAt?.getTime() ?? 0) - (o.receivedAt?.getTime() ?? 0)) < 2 * DAY);
    if (!twin) {
      list.push(o);
      kept.set(k, list);
    } else if ((SOURCE_RANK[o.source] ?? 9) < (SOURCE_RANK[twin.source] ?? 9)) {
      drop.push(twin._id);
      list[list.indexOf(twin)] = o;
    } else {
      drop.push(o._id);
    }
  }
  if (drop.length) await Message.deleteMany({ _id: { $in: drop } });
  return drop.length;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Messages without an item number (often your own replies from the Sent folder) would form their own
 * thread. Attach each to the same buyer's item conversation closest in time (within 14 days).
 */
export async function attachOrphans(storeId: Types.ObjectId): Promise<number> {
  const orphans = await Message.find({ storeId, itemId: "", buyer: { $ne: "" } }).select("buyer receivedAt").lean();
  let moved = 0;
  for (const o of orphans) {
    const at = o.receivedAt ? new Date(o.receivedAt).getTime() : Date.now();
    const near = await Message.find({
      storeId,
      buyer: new RegExp(`^${escapeRegex(o.buyer)}$`, "i"),
      itemId: { $ne: "" },
      receivedAt: { $gte: new Date(at - 14 * DAY), $lte: new Date(at + 14 * DAY) },
    })
      .select("threadKey itemId itemTitle receivedAt")
      .lean();
    if (!near.length) continue;
    const dist = (m: (typeof near)[number]) => Math.abs((m.receivedAt ? new Date(m.receivedAt).getTime() : 0) - at);
    const best = near.sort((a, b) => dist(a) - dist(b))[0];
    await Message.updateOne(
      { _id: o._id },
      { $set: { threadKey: best.threadKey, itemId: best.itemId, ...(best.itemTitle ? { itemTitle: best.itemTitle } : {}) } },
    );
    moved++;
  }
  return moved;
}

export async function syncMessages(ctx: SyncContext): Promise<SyncResult> {
  const now = new Date();
  const cursorAt = ctx.cursor?.at ? new Date(ctx.cursor.at) : null;
  const from = cursorAt ? new Date(cursorAt.getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_LOOKBACK_DAYS * DAY);
  const sellerId = ctx.store.ebayUserId;
  const t = ctx.clients.trading;

  const headers = await fetchHeaders(t, sellerId, from, now);
  const questions = await fetchQuestions(t, sellerId, from, now);
  const created = await upsertMessages(ctx.store._id, [...headers, ...questions]);
  await repairBodies(ctx.store._id);
  const bodies = await fillBodies(ctx.store._id, t);
  await attachOrphans(ctx.store._id);
  await dedupeOutbound(ctx.store._id);
  ctx.log(`${headers.length} message headers, ${questions.length} question rows, ${bodies} bodies`);
  return {
    cursor: { at: now.toISOString() },
    summary: `${headers.length + questions.length} messages checked${created ? `, ${created} new` : ""}`,
  };
}
