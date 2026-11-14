/** The core loop: sync -> pull batch -> improve each listing -> push -> next batch. */
import { Types } from "mongoose";
import { decrypt } from "../lib/crypto";
import { suggestImprovements, type ClaudeSuggestion } from "../lib/claude";
import { userAccessToken } from "../lib/ebay/auth";
import { RestClient } from "../lib/ebay/rest";
import { TradingClient } from "../lib/ebay/trading";
import type { EbayItem, ListingChanges } from "../lib/ebay/types";
import { checkCompatibility, checkPrice, checkSpecifics, checkTitle } from "../lib/guardrails";
import { logger, sleep } from "../lib/logger";
import { Batch } from "../models/Batch";
import { Listing } from "../models/Listing";
import { Proposal, type ProposalStatus } from "../models/Proposal";
import { resolveSettings, Store, type StoreDocument, type StoreSettings } from "../models/Store";
import { addUsage, monthSpend } from "../models/Usage";

export interface PipelineDeps {
  trading: Pick<TradingClient, "allActiveListings" | "getItem" | "reviseItem">;
  rest: Pick<RestClient, "aspectsForCategory" | "competitorsFor">;
  suggest: typeof suggestImprovements;
  /** injectable for tests */
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(store: StoreDocument): PipelineDeps {
  const refresh = decrypt(store.auth.refreshTokenEnc);
  return {
    trading: new TradingClient(() => userAccessToken(String(store._id), refresh), store.siteId),
    rest: new RestClient(store.marketplaceId),
    suggest: suggestImprovements,
    sleep,
  };
}

export class BudgetExceeded extends Error {}

/** A listing that failed is picked again automatically after this many hours. */
export const ERROR_RETRY_HOURS = 24;

// ---------------------------------------------------------------- sync
export async function syncListings(store: StoreDocument, deps: PipelineDeps): Promise<number> {
  const items = await deps.trading.allActiveListings();
  const now = new Date();
  if (items.length) {
    await Listing.bulkWrite(
      items.map((it) => ({
        updateOne: {
          filter: { storeId: store._id, itemId: it.itemId },
          update: {
            $set: {
              title: it.title, sku: it.sku, price: it.price, quantitySold: it.quantitySold,
              watchCount: it.watchCount, listingType: it.listingType, imageUrl: it.imageUrl,
              active: true, lastSyncedAt: now,
            },
          },
          upsert: true,
        },
      })),
    );
  }
  await Listing.updateMany({ storeId: store._id, lastSyncedAt: { $lt: now } }, { $set: { active: false } });
  await Store.updateOne({ _id: store._id }, { $set: { lastSyncAt: now } });
  logger.info(`[${store.name}] synced ${items.length} active listings`);
  return items.length;
}

export async function syncIfDue(store: StoreDocument, deps: PipelineDeps) {
  const s = resolveSettings(store.settings);
  if (!store.lastSyncAt || Date.now() - store.lastSyncAt.getTime() > s.resyncHours * 3600_000) {
    await syncListings(store, deps);
  }
}

// ---------------------------------------------------------------- one listing
export function buildChanges(
  item: EbayItem,
  suggestion: ClaudeSuggestion,
  aspects: Parameters<typeof checkSpecifics>[2],
  cost: number | null,
  s: StoreSettings,
): { changes: ListingChanges; notes: string[]; suggestedCompat: Record<string, string>[] } {
  const changes: ListingChanges = {};
  const notes: string[] = [];
  if (s.modules.title.enabled) {
    const t = checkTitle(item.title, suggestion.title);
    notes.push(t.note);
    if (t.value) changes.title = t.value;
  }
  const p = checkPrice(item, suggestion.recommended_price, cost, s.modules.pricing);
  notes.push(p.note);
  if (p.value) changes.price = p.value;
  const sp = checkSpecifics(item, suggestion.item_specifics, aspects, s.modules.specifics);
  notes.push(...sp.notes);
  if (sp.value) changes.itemSpecifics = sp.value;
  const c = checkCompatibility(item, suggestion.compatibility, s.modules.compatibility);
  if (c.note) notes.push(c.note);
  if (c.value) changes.compatibilityAdd = c.value;
  return { changes, notes, suggestedCompat: c.suggested };
}

async function processItem(store: StoreDocument, s: StoreSettings, deps: PipelineDeps, batchId: Types.ObjectId, itemId: string) {
  if ((await monthSpend(store._id)) >= s.claude.monthlyBudgetUsd) {
    throw new BudgetExceeded(`Monthly Claude budget $${s.claude.monthlyBudgetUsd} reached`);
  }
  const item = await deps.trading.getItem(itemId);
  const base = { storeId: store._id, batchId, itemId, before: item };
  if (!["FixedPriceItem", "StoresFixedPrice"].includes(item.listingType)) {
    await Proposal.create({ ...base, status: "skipped", notes: ["auction listing - skipped"] });
    return "skipped";
  }
  // Item specifics are a nice-to-have: if eBay's category lookup fails, still optimize title/price.
  let aspects: Awaited<ReturnType<PipelineDeps["rest"]["aspectsForCategory"]>> = [];
  let aspectNote = "";
  try {
    aspects = await deps.rest.aspectsForCategory(item.categoryId);
  } catch (e: any) {
    aspectNote = `item specifics skipped: category ${item.categoryId} lookup failed (${String(e?.message ?? e).slice(0, 160)})`;
    logger.warn(`[${store.name}] ${itemId}: ${aspectNote}`);
  }
  const { query, competitors } = await deps.rest.competitorsFor(item, s.excludeSeller, s.competitorCount);
  let result;
  try {
    result = await deps.suggest(item, aspects, competitors, s.claude);
  } catch (e: any) {
    if (e?.costUsd) await addUsage(store._id, e.costUsd, 0, 0);
    throw e;
  }
  await addUsage(store._id, result.costUsd, result.inputTokens, result.outputTokens);

  const listing = await Listing.findOne({ storeId: store._id, itemId }).lean();
  const { changes, notes, suggestedCompat } = buildChanges(item, result.suggestion, aspects, listing?.cost ?? null, s);
  const status = Object.keys(changes).length ? "proposed" : "no_change";
  await Proposal.create({
    ...base,
    status,
    suggestion: { ...result.suggestion, suggested_compatibility_rows: suggestedCompat },
    changes,
    notes: [`competitor query: "${query}" (${competitors.length} found)`, ...(aspectNote ? [aspectNote] : []), ...notes],
    competitorQuery: query,
    competitors,
    costUsd: result.costUsd,
  });
  logger.info(`[${store.name}] ${itemId}: ${status} (${Object.keys(changes).join(", ") || "-"}) $${result.costUsd.toFixed(3)}`);
  return status;
}

// ---------------------------------------------------------------- batch
export async function recountBatch(batchId: Types.ObjectId) {
  const rows = await Proposal.aggregate([{ $match: { batchId } }, { $group: { _id: "$status", n: { $sum: 1 }, usd: { $sum: "$costUsd" } } }]);
  const by = (st: string) => rows.find((r) => r._id === st)?.n ?? 0;
  const total = rows.reduce((a, r) => a + r.n, 0);
  await Batch.updateOne(
    { _id: batchId },
    {
      $set: {
        "counts.processed": total,
        "counts.proposed": by("proposed") + by("approved"),
        "counts.noChange": by("no_change") + by("skipped"),
        "counts.errors": by("error"),
        "counts.pushed": by("pushed") + by("reverted"),
        "counts.failed": by("failed"),
        costUsd: rows.reduce((a, r) => a + r.usd, 0),
      },
    },
  );
}

export async function pickNextItems(store: StoreDocument, size: number, cooldownDays: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - cooldownDays * 86400_000);
  const errorCutoff = new Date(Date.now() - ERROR_RETRY_HOURS * 3600_000);
  const rows = await Listing.find({
    storeId: store._id,
    active: true,
    listingType: { $ne: "Chinese" },
    $and: [
      { $or: [{ lastProcessedAt: null }, { lastProcessedAt: { $lt: cutoff } }] },
      // a listing that just failed is retried automatically later, not in every batch
      { $or: [{ lastErrorAt: null }, { lastErrorAt: { $exists: false } }, { lastErrorAt: { $lt: errorCutoff } }] },
    ],
  })
    .sort({ lastProcessedAt: 1, quantitySold: 1, watchCount: 1 })
    .limit(size)
    .select("itemId")
    .lean();
  return rows.map((r) => r.itemId);
}

export async function runBatch(
  store: StoreDocument,
  deps: PipelineDeps,
  opts: { limit?: number; itemIds?: string[]; trigger?: "schedule" | "manual"; shouldStop?: () => Promise<boolean> } = {},
) {
  const s = resolveSettings(store.settings);
  const ids = opts.itemIds?.length ? opts.itemIds : await pickNextItems(store, opts.limit ?? s.batchSize, s.cooldownDays);
  if (!ids.length) {
    logger.info(`[${store.name}] no listings due (all processed within cooldown)`);
    return null;
  }
  const number = (await Batch.countDocuments({ storeId: store._id })) + 1;
  const batch = await Batch.create({
    storeId: store._id, number, mode: s.mode, trigger: opts.trigger ?? "manual", counts: { total: ids.length },
  });
  logger.info(`[${store.name}] batch #${number}: ${ids.length} listings, mode=${s.mode}`);

  let stopReason = "";
  for (let i = 0; i < ids.length; i++) {
    if (opts.shouldStop && (await opts.shouldStop())) {
      stopReason = "stopped by user";
      break;
    }
    try {
      await processItem(store, s, deps, batch._id, ids[i]);
      await Listing.updateOne(
        { storeId: store._id, itemId: ids[i] },
        { $set: { lastProcessedAt: new Date() }, $unset: { lastErrorAt: 1 } },
      );
    } catch (e: any) {
      if (e instanceof BudgetExceeded) {
        stopReason = e.message;
        break;
      }
      logger.error(`[${store.name}] ${ids[i]} failed`, e);
      await Proposal.create({ storeId: store._id, batchId: batch._id, itemId: ids[i], status: "error", error: String(e?.message ?? e) });
      // not marked as processed -> no 21-day cooldown; retried after ERROR_RETRY_HOURS
      await Listing.updateOne({ storeId: store._id, itemId: ids[i] }, { $set: { lastErrorAt: new Date() } });
    }
    await recountBatch(batch._id);
    if (i < ids.length - 1) await deps.sleep(s.gapBetweenListingsSec * 1000);
  }

  await recountBatch(batch._id);
  if (s.mode === "auto") {
    await pushProposals(store, deps, batch._id, ["proposed"]);
  } else {
    await Batch.updateOne({ _id: batch._id }, { $set: { status: "review", finishedAt: new Date(), error: stopReason || undefined } });
  }
  if (stopReason) await Batch.updateOne({ _id: batch._id }, { $set: { error: stopReason } });
  return Batch.findById(batch._id);
}

// ---------------------------------------------------------------- push / revert
/** Pushes proposals of a batch with the given statuses (review mode: "approved"; auto: "proposed"). */
export async function pushProposals(
  store: StoreDocument,
  deps: PipelineDeps,
  batchId: Types.ObjectId,
  statuses: ProposalStatus[] = ["approved"],
) {
  const s = resolveSettings(store.settings);
  await Batch.updateOne({ _id: batchId }, { $set: { status: "pushing" } });
  const rows = await Proposal.find({ batchId, storeId: store._id, status: { $in: statuses } }).sort({ _id: 1 });
  for (const p of rows) {
    const changes = (p.changes ?? {}) as ListingChanges;
    if (!Object.keys(changes).length) {
      p.status = "no_change";
      await p.save();
      continue;
    }
    try {
      const warnings = await deps.trading.reviseItem(p.itemId, changes, (p.before as EbayItem | undefined)?.site);
      p.status = "pushed";
      p.pushedAt = new Date();
      p.warnings = warnings;
      p.error = "";
      const set: Record<string, unknown> = {};
      if (changes.title) set.title = changes.title;
      if (changes.price) set.price = changes.price;
      if (Object.keys(set).length) await Listing.updateOne({ storeId: store._id, itemId: p.itemId }, { $set: set });
      logger.info(`[${store.name}] pushed ${p.itemId}: ${Object.keys(changes).join(", ")}`);
    } catch (e: any) {
      p.status = "failed";
      p.error = String(e?.message ?? e);
      logger.error(`[${store.name}] push failed ${p.itemId}: ${p.error}`);
    }
    await p.save();
    await deps.sleep(s.gapBetweenPushesSec * 1000);
  }
  await recountBatch(batchId);
  const pending = await Proposal.countDocuments({ batchId, status: { $in: ["proposed", "approved"] } });
  await Batch.updateOne({ _id: batchId }, { $set: { status: pending ? "review" : "done", finishedAt: new Date() } });
}

/** Restores title / price / item specifics from the snapshot taken before the change.
 *  (Compatibility rows that were added are not removed automatically.) */
export async function revertProposal(store: StoreDocument, deps: PipelineDeps, proposalId: string) {
  const p = await Proposal.findOne({ _id: proposalId, storeId: store._id });
  if (!p) throw new Error("Proposal not found");
  if (p.status !== "pushed") throw new Error("Only pushed changes can be reverted");
  const before = p.before as EbayItem;
  const changes = p.changes as ListingChanges;
  const revert: ListingChanges = {};
  if (changes.title) revert.title = before.title;
  if (changes.price) revert.price = before.price;
  if (changes.itemSpecifics) revert.itemSpecifics = before.itemSpecifics;
  if (!Object.keys(revert).length) throw new Error("Nothing to revert (compatibility-only change)");
  await deps.trading.reviseItem(p.itemId, revert, before?.site);
  p.status = "reverted";
  p.revertedAt = new Date();
  await p.save();
  const set: Record<string, unknown> = {};
  if (revert.title) set.title = revert.title;
  if (revert.price) set.price = revert.price;
  if (Object.keys(set).length) await Listing.updateOne({ storeId: store._id, itemId: p.itemId }, { $set: set });
  return p;
}
