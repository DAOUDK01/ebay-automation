/** Feedback sync, counts, summary and the "leave feedback" action shared by the API and auto-feedback. */
import type { Types } from "mongoose";
import type { StoreDocument } from "../../models/Store";
import type { Counts, SyncContext, SyncResult } from "../types";
import {
  getFeedbackPage,
  getFeedbackProfile,
  getItemsAwaitingFeedback,
  leaveFeedback,
  type FeedbackKind,
  type ParsedFeedback,
  type PeriodCounts,
  type Trading,
} from "./ebay";
import { Feedback, FeedbackAwaiting, feedbackSettings } from "./model";

const DAY = 86400_000;
/** first run reads up to this many pages (200 each) per feedback type; later runs stop at the cursor */
export const MAX_PAGES = 10;
/** re-read a little before the cursor so late replies / follow-ups are picked up */
const OVERLAP_MS = 7 * DAY;
/** auto-feedback leaves at most this many per sync run */
export const AUTO_LIMIT = 25;

export interface FeedbackCursor {
  received?: string | null;
  left?: string | null;
}

async function saveFeedback(storeId: Types.ObjectId, rows: ParsedFeedback[]) {
  if (!rows.length) return;
  await Feedback.bulkWrite(
    rows.map((f) => {
      const { response, ...rest } = f;
      // eBay is the source of truth for replies, but never wipe a reply we just posted that eBay hasn't returned yet
      return {
        updateOne: {
          filter: { storeId, feedbackId: f.feedbackId },
          update: response ? { $set: { ...rest, response } } : { $set: rest, $setOnInsert: { response: "" } },
          upsert: true,
        },
      };
    }),
  );
}

/** Page through one feedback type, newest first, until we pass the cursor. Returns rows saved + newest date. */
async function syncKind(t: Trading, store: StoreDocument, kind: FeedbackKind, since: Date | null) {
  let saved = 0;
  let newest: Date | null = null;
  let summary: Partial<PeriodCounts> | null = null;
  const stopBefore = since ? new Date(since.getTime() - OVERLAP_MS) : null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await getFeedbackPage(t, kind, page, store.ebayUserId);
    if (page === 1) summary = r.summary;
    await saveFeedback(store._id, r.items);
    saved += r.items.length;
    for (const f of r.items) if (!newest || f.date > newest) newest = f.date;
    const reachedCursor = stopBefore && r.items.some((f) => f.date < stopBefore);
    if (!r.items.length || page >= r.pages || reachedCursor) break;
  }
  return { saved, newest, summary };
}

/** Leave positive feedback for one awaiting sale; records it as "left" and removes it from the awaiting list. */
export async function leaveForAwaiting(t: Trading, storeId: Types.ObjectId, row: any, text: string) {
  const feedbackId = await leaveFeedback(t, {
    itemId: row.itemId,
    transactionId: row.transactionId,
    orderLineItemId: row.orderLineItemId,
    buyer: row.buyer,
    text,
  });
  await Feedback.updateOne(
    { storeId, feedbackId: feedbackId || `local-${row.itemId}-${row.transactionId || row.orderLineItemId}` },
    {
      $set: {
        direction: "left",
        role: "Buyer",
        rating: "Positive",
        comment: text,
        user: row.buyer,
        itemId: row.itemId,
        itemTitle: row.title,
        transactionId: row.transactionId,
        orderLineItemId: row.orderLineItemId,
        date: new Date(),
      },
    },
    { upsert: true },
  );
  await FeedbackAwaiting.deleteOne({ _id: row._id });
  return feedbackId;
}

export async function syncFeedback(ctx: SyncContext): Promise<SyncResult> {
  const { store } = ctx;
  const t = ctx.clients.trading;
  const cursor: FeedbackCursor = ctx.cursor ?? {};
  const since = (s?: string | null) => (s ? new Date(s) : null);

  const received = await syncKind(t, store, "FeedbackReceivedAsSeller", since(cursor.received));
  const left = await syncKind(t, store, "FeedbackLeft", since(cursor.left));

  const settings = await feedbackSettings(store._id);
  const profile = await getFeedbackProfile(t).catch((e) => {
    ctx.log(`GetUser failed: ${e?.message ?? e}`);
    return null;
  });
  if (profile || received.summary) {
    settings.set("profile", {
      score: profile?.score ?? settings.profile?.score ?? null,
      positivePercent: profile?.positivePercent ?? settings.profile?.positivePercent ?? null,
      star: profile?.star ?? settings.profile?.star ?? "",
      periods: received.summary ?? settings.profile?.periods ?? null,
      updatedAt: new Date(),
    });
    await settings.save();
  }

  // awaiting list: replace with what eBay says now
  const now = new Date();
  const awaiting = await getItemsAwaitingFeedback(t);
  if (awaiting.length) {
    await FeedbackAwaiting.bulkWrite(
      awaiting.map((a) => ({
        updateOne: {
          filter: { storeId: store._id, itemId: a.itemId, transactionId: a.transactionId },
          update: { $set: { ...a, lastSyncedAt: now } },
          upsert: true,
        },
      })),
    );
  }
  await FeedbackAwaiting.deleteMany({ storeId: store._id, $or: [{ lastSyncedAt: { $lt: now } }, { lastSyncedAt: null }] });

  // opt-in auto-positive feedback (sales on eBay are paid at checkout, so everything awaiting is paid)
  let auto = 0;
  let autoFailed = 0;
  if (settings.autoPositive) {
    const rows = await FeedbackAwaiting.find({ storeId: store._id }).sort({ endTime: 1 }).limit(AUTO_LIMIT).lean();
    for (const row of rows) {
      try {
        await leaveForAwaiting(t, store._id, row, settings.autoText);
        auto++;
      } catch (e: any) {
        autoFailed++;
        ctx.log(`auto-feedback for ${row.buyer} (${row.itemId}) failed: ${e?.message ?? e}`);
      }
    }
  }

  const next: FeedbackCursor = {
    received: (received.newest ?? since(cursor.received))?.toISOString() ?? null,
    left: (left.newest ?? since(cursor.left))?.toISOString() ?? null,
  };
  const parts = [`${received.saved} received`, `${left.saved} left`, `${awaiting.length - auto} awaiting`];
  if (settings.autoPositive) parts.push(`${auto} auto-left${autoFailed ? ` (${autoFailed} failed)` : ""}`);
  return { cursor: next, summary: `Feedback: ${parts.join(", ")}` };
}

/** Neutral/negative received in the last 30 days that we haven't replied to. */
export const needsReplyFilter = (storeId: Types.ObjectId): Record<string, any> => ({
  storeId,
  direction: "received",
  rating: { $in: ["Neutral", "Negative"] },
  date: { $gte: new Date(Date.now() - 30 * DAY) },
  response: "",
});

export async function feedbackCounts(store: StoreDocument): Promise<Counts> {
  return { negativeFeedback: await Feedback.countDocuments(needsReplyFilter(store._id)) };
}

/** Our own counts of received feedback for the last 30/90/365 days. */
export async function localPeriods(storeId: Types.ObjectId): Promise<PeriodCounts> {
  const out = {} as PeriodCounts;
  for (const days of ["30", "90", "365"] as const) {
    const rows = await Feedback.aggregate<{ _id: string; n: number }>([
      { $match: { storeId, direction: "received", date: { $gte: new Date(Date.now() - Number(days) * DAY) } } },
      { $group: { _id: "$rating", n: { $sum: 1 } } },
    ]);
    const n = (r: string) => rows.find((x) => x._id === r)?.n ?? 0;
    out[days] = { positive: n("Positive"), neutral: n("Neutral"), negative: n("Negative") };
  }
  return out;
}
