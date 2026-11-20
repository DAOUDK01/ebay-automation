/** Background refresh of returns, cancellations and cases from the Post-Order API. */
import type { Types } from "mongoose";
import type { PostOrderClient } from "../../lib/ebay/sell";
import { Listing } from "../../models/Listing";
import type { SyncContext, SyncResult } from "../types";
import { DETAIL_PATH, MAPPERS, mapTimeline, searchAll, summaryFromDetail, type MappedCase } from "./ebay";
import { POST_ORDER_KINDS, PostOrderCase, type PostOrderKind } from "./model";

const DAY = 86_400_000;
/** first sync looks back this far */
export const FIRST_LOOKBACK_DAYS = 120;
/** later syncs re-read everything created since (last sync - this), to catch status changes */
export const OVERLAP_DAYS = 30;
/** never look back further than this, even for a very old open case */
const MAX_LOOKBACK_DAYS = 540;

/** Where to start searching: since the last sync (with overlap), but never after the oldest row still open. */
export async function searchFrom(storeId: Types.ObjectId, kind: PostOrderKind, cursorAt: Date | null, now = new Date()): Promise<Date> {
  let from = cursorAt ? new Date(cursorAt.getTime() - OVERLAP_DAYS * DAY) : new Date(now.getTime() - FIRST_LOOKBACK_DAYS * DAY);
  const oldestOpen = await PostOrderCase.findOne({ storeId, kind, open: true, openedAt: { $ne: null } }).sort({ openedAt: 1 }).select("openedAt").lean();
  if (oldestOpen?.openedAt && oldestOpen.openedAt < from) from = new Date(oldestOpen.openedAt.getTime() - DAY);
  const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * DAY);
  return from < floor ? floor : from;
}

/** Upsert mapped rows; item titles come from our Listing table. Returns how many rows were new. */
export async function upsertCases(storeId: Types.ObjectId, rows: MappedCase[], now = new Date()): Promise<{ created: number; updated: number }> {
  if (!rows.length) return { created: 0, updated: 0 };
  const itemIds = [...new Set(rows.map((r) => r.itemId).filter(Boolean))];
  const titles = new Map(
    (await Listing.find({ storeId, itemId: { $in: itemIds } }).select("itemId title").lean()).map((l) => [l.itemId, l.title ?? ""]),
  );
  const res = await PostOrderCase.bulkWrite(
    rows
      .filter((r) => r.ebayId)
      .map((r) => {
        const { kind, ebayId, ...rest } = r;
        const title = titles.get(r.itemId);
        return {
          updateOne: {
            filter: { storeId, kind, ebayId },
            update: { $set: { ...rest, ...(title ? { itemTitle: title } : {}), syncedAt: now } },
            upsert: true,
          },
        };
      }),
  );
  return { created: res.upsertedCount, updated: res.modifiedCount };
}

/** Pull one row's full detail (history) from eBay and save it. */
export async function refreshDetail(storeId: Types.ObjectId, client: Pick<PostOrderClient, "get">, kind: PostOrderKind, ebayId: string) {
  const detail = await client.get(DETAIL_PATH[kind](ebayId));
  const summary = summaryFromDetail(kind, detail);
  const mapped = MAPPERS[kind]({ ...summary, ...(kind === "case" ? { caseId: ebayId } : {}) });
  mapped.ebayId = ebayId;
  await upsertCases(storeId, [mapped]);
  const timeline = mapTimeline(kind, detail);
  const title = detail?.detail?.itemDetail?.itemTitle;
  await PostOrderCase.updateOne(
    { storeId, kind, ebayId },
    { $set: { detailRaw: detail, ...(timeline.length ? { timeline } : {}), ...(title ? { itemTitle: String(title) } : {}) } },
  );
}

const LABEL: Record<PostOrderKind, string> = { return: "returns", cancellation: "cancellations", case: "cases" };

export async function syncReturns(ctx: SyncContext): Promise<SyncResult> {
  const now = new Date();
  const cursorAt = ctx.cursor?.at ? new Date(ctx.cursor.at) : null;
  const parts: string[] = [];
  const errors: string[] = [];
  for (const kind of POST_ORDER_KINDS) {
    try {
      const from = await searchFrom(ctx.store._id, kind, cursorAt, now);
      const raw = await searchAll(ctx.clients.postOrder, kind, from);
      const { created } = await upsertCases(ctx.store._id, raw.map(MAPPERS[kind]), now);
      parts.push(`${raw.length} ${LABEL[kind]}${created ? ` (${created} new)` : ""}`);
      ctx.log(`${raw.length} ${LABEL[kind]} since ${from.toISOString().slice(0, 10)}`);
    } catch (e: any) {
      errors.push(`${LABEL[kind]}: ${e?.message ?? e}`);
    }
  }
  // a partial failure still fails the run (so the cursor isn't advanced past what we missed)
  if (errors.length) throw new Error(errors.join("; "));
  return { cursor: { at: now.toISOString() }, summary: parts.join(", ") };
}
