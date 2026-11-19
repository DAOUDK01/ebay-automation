/** The core loop: sync -> pull batch -> improve each listing -> push -> next batch. */
import { Types } from "mongoose";
import { decrypt } from "../lib/crypto";
import { suggestImprovements, type ClaudeSuggestion } from "../lib/claude";
import { userAccessToken } from "../lib/ebay/auth";
import { RestClient } from "../lib/ebay/rest";
import { TradingClient } from "../lib/ebay/trading";
import type { EbayItem, FitmentRow, ListingChanges, ShippingAnalysis, ShippingPolicy } from "../lib/ebay/types";
import { groupFitment, hasContent, isAplus, renderAplus } from "../lib/description";
import { keywords, rankRelated, type RelatedItem } from "../lib/related";
import { buildFitmentRows, gatherFitmentEvidence, type FitmentDeps } from "../lib/fitment";
import { analyzeShipping, withKg } from "../lib/shipping";
import { checkCompatibility, checkPrice, checkSpecifics, checkTitle } from "../lib/guardrails";
import { logger, sleep } from "../lib/logger";
import { Batch } from "../models/Batch";
import { Listing } from "../models/Listing";
import { Proposal, type ProposalStatus } from "../models/Proposal";
import { resolveSettings, Store, type StoreDocument, type StoreSettings } from "../models/Store";
import { addUsage, monthSpend } from "../models/Usage";

export interface PipelineDeps {
  trading: Pick<TradingClient, "allActiveListings" | "getItem" | "reviseItem"> &
    Partial<Pick<TradingClient, "getItemCompatibility" | "getShippingPolicies">>;
  rest: Pick<RestClient, "aspectsForCategory" | "competitorsFor"> &
    Partial<Pick<RestClient, "searchByPartNumber" | "validateVehicle">>;
  suggest: typeof suggestImprovements;
  /** injectable for tests */
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(store: StoreDocument): PipelineDeps {
  const refresh = decrypt(store.auth.refreshTokenEnc);
  return {
    trading: new TradingClient(() => userAccessToken(String(store._id), refresh, store.auth.scopes), store.siteId),
    rest: new RestClient(store.marketplaceId),
    suggest: suggestImprovements,
    sleep,
  };
}

export class BudgetExceeded extends Error {}

/** A listing that failed is picked again automatically after this many hours. */
export const ERROR_RETRY_HOURS = 24;

// ---------------------------------------------------------------- shipping policies (cached per store)
const policyCache = new Map<string, { at: number; list: ShippingPolicy[] }>();
const POLICY_TTL = 30 * 60_000;

export async function getShippingPolicies(store: StoreDocument, deps: PipelineDeps, fresh = false): Promise<ShippingPolicy[]> {
  const key = String(store._id);
  const c = policyCache.get(key);
  if (!fresh && c && Date.now() - c.at < POLICY_TTL) return c.list;
  if (!deps.trading.getShippingPolicies) return [];
  const list = withKg(await deps.trading.getShippingPolicies());
  policyCache.set(key, { at: Date.now(), list });
  return list;
}

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

// ---------------------------------------------------------------- related items
/** Other active items from the store for "You may also like" (same vehicle first, then shared part words). */
export async function findRelated(storeId: Types.ObjectId, item: EbayItem, count: number): Promise<RelatedItem[]> {
  try {
    const top = groupFitment(item.compatibilityAll ?? item.compatibilitySample ?? [])[0]?.vehicle ?? "";
    const vehicle = (top ? top.split(" ") : keywords(item.title).slice(0, 2)).filter((w) => w.length > 1);
    const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const base = { storeId, active: true, itemId: { $ne: item.itemId }, imageUrl: /^https:\/\//, price: { $gt: 0 } };
    const fields = "itemId title price imageUrl quantitySold";
    let pool: RelatedItem[] = [];
    // same make + model, then same model, then best sellers
    for (const words of [vehicle, vehicle.slice(-1)]) {
      if (!words.length || pool.length >= count * 3) continue;
      const q = { ...base, $and: words.map((w) => ({ title: { $regex: `\\b${esc(w)}\\b`, $options: "i" } })) };
      pool = pool.concat((await Listing.find(q).select(fields).sort({ quantitySold: -1 }).limit(150).lean()) as any);
    }
    if (pool.length < count) pool = pool.concat((await Listing.find(base).select(fields).sort({ quantitySold: -1, watchCount: -1 }).limit(40).lean()) as any);
    return rankRelated(item, vehicle, pool, count);
  } catch (e: any) {
    logger.warn(`related items lookup failed: ${e?.message ?? e}`);
    return [];
  }
}

// ---------------------------------------------------------------- one listing
export function buildChanges(
  item: EbayItem,
  suggestion: ClaudeSuggestion,
  aspects: Parameters<typeof checkSpecifics>[2],
  cost: number | null,
  s: StoreSettings,
  fitmentRows: FitmentRow[] = [],
  specificsEvidenceNames: string[] = [],
  shipping: ShippingAnalysis | null = null,
  ctx: { storeName?: string; sellerId?: string; related?: RelatedItem[] } = {},
): { changes: ListingChanges; notes: string[]; suggestedCompat: FitmentRow[] } {
  const changes: ListingChanges = {};
  const notes: string[] = [];
  if (s.modules.title.enabled) {
    const t = checkTitle(item.title, suggestion.title, s.modules.title.template);
    notes.push(t.note);
    if (t.value) changes.title = t.value;
  }
  const p = checkPrice(item, suggestion.recommended_price, cost, s.modules.pricing);
  notes.push(p.note);
  if (p.value) changes.price = p.value;
  const sp = checkSpecifics(item, suggestion.item_specifics, aspects, s.modules.specifics, specificsEvidenceNames);
  notes.push(...sp.notes);
  if (sp.value) changes.itemSpecifics = sp.value;
  const c = checkCompatibility(fitmentRows, s.modules.compatibility);
  if (c.note) notes.push(c.note);
  if (c.value) changes.compatibilityAdd = c.value;
  if (shipping && s.modules.shipping.enabled) {
    notes.push(`shipping: ${shipping.note}`);
    // switch policy only when we're confident which bracket is right
    // part-name policies come from the title, so they don't depend on the weight estimate
    const confident = shipping.rule === "part" || shipping.source === "listing" || shipping.confidence !== "low";
    // too heavy for every policy: still move it UP to the largest policy (better than undercharging), never down
    const heavyOk =
      !shipping.overMax || (shipping.current?.kg != null && shipping.suggested?.kg != null && shipping.current.kg < shipping.suggested.kg);
    if (s.modules.shipping.apply && shipping.suggested && !shipping.matches && heavyOk && confident && shipping.suggested.id) {
      changes.shippingPolicyId = shipping.suggested.id;
    }
  }
  const d = s.modules.description;
  if (d.enabled) {
    if (!hasContent(suggestion.description_content)) {
      notes.push("description: Claude returned no content - kept current");
    } else {
      const html = renderAplus({
        content: suggestion.description_content,
        title: changes.title ?? item.title,
        condition: item.condition,
        pictures: item.pictures?.length ? item.pictures : item.imageUrl ? [item.imageUrl] : [],
        specifics: { ...item.itemSpecifics, ...(changes.itemSpecifics ?? {}) },
        compatibility: [...(item.compatibilityAll ?? item.compatibilitySample ?? []), ...(changes.compatibilityAdd ?? [])],
        currentHtml: item.descriptionHtml,
        brand: d,
        storeName: ctx.storeName ?? "",
        sellerId: ctx.sellerId,
        price: changes.price ?? item.price,
        currency: item.currency,
        related: ctx.related,
      });
      if (html !== item.descriptionHtml) {
        changes.description = html;
        notes.push(isAplus(item.descriptionHtml) ? "description: branded A+ content refreshed" : "description: new branded A+ content");
      }
    }
  }
  return { changes, notes, suggestedCompat: c.suggested };
}

async function processItem(store: StoreDocument, s: StoreSettings, deps: PipelineDeps, batchId: Types.ObjectId, itemId: string) {
  if ((await monthSpend(store._id)) >= s.claude.monthlyBudgetUsd) {
    throw new BudgetExceeded(`Monthly Claude budget $${s.claude.monthlyBudgetUsd} reached`);
  }
  const item = await deps.trading.getItem(itemId);
  // snapshot for review/revert; the raw description HTML isn't needed for optimizer changes
  const { descriptionHtml: _html, ...snapshot } = item;
  const base = { storeId: store._id, batchId, itemId, before: snapshot };
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

  // fitment research: other eBay listings with the same part number -> their compatibility tables
  const fitDeps: FitmentDeps = {
    searchByPartNumber: deps.rest.searchByPartNumber?.bind(deps.rest),
    getItemCompatibility: deps.trading.getItemCompatibility?.bind(deps.trading),
    validateVehicle: deps.rest.validateVehicle?.bind(deps.rest),
  };
  const evidence = await gatherFitmentEvidence(item, fitDeps, s, (m) => logger.warn(`[${store.name}] ${itemId}: ${m}`));

  // shipping policies first, so Claude can say whether this item belongs to a part policy (e.g. Gear Box)
  let policies: ShippingPolicy[] = [];
  if (s.modules.shipping.enabled) {
    try {
      policies = await getShippingPolicies(store, deps);
    } catch (e: any) {
      logger.warn(`[${store.name}] couldn't load shipping policies: ${e?.message ?? e}`);
    }
  }
  const partPolicies = policies.filter((p) => !p.copy && p.parts?.length).map((p) => ({ name: p.name, part: p.parts![0] }));

  let result;
  try {
    result = await deps.suggest(
      item,
      aspects,
      competitors,
      {
        ...s.claude,
        titleTemplate: s.modules.title.enabled ? s.modules.title.template : "",
        wantDescription: s.modules.description.enabled,
        partPolicies,
      },
      {
        partNumbers: evidence.partNumbers,
        summary: evidence.summary,
        referenceCount: evidence.references.filter((r) => r.rowCount > 0).length,
        specifics: evidence.specifics,
      },
    );
  } catch (e: any) {
    if (e?.costUsd) await addUsage(store._id, e.costUsd, 0, 0);
    throw e;
  }
  await addUsage(store._id, result.costUsd, result.inputTokens, result.outputTokens);

  const fit = await buildFitmentRows(item, evidence, result.suggestion.compatibility, fitDeps, s);

  let shipping: ShippingAnalysis | null = null;
  if (s.modules.shipping.enabled) {
    // Claude's answer (when it gave one) decides whether a part policy applies
    const said = partPolicies.length ? result.suggestion.shipping_part_policy : undefined;
    shipping = analyzeShipping(item, result.suggestion.shipping_estimate, policies, s.modules.shipping, said);
  }

  const listing = await Listing.findOne({ storeId: store._id, itemId }).lean();
  const { changes, notes, suggestedCompat } = buildChanges(
    item,
    result.suggestion,
    aspects,
    listing?.cost ?? null,
    s,
    fit.rows,
    evidence.specifics.map((e) => e.name),
    shipping,
    {
      storeName: store.ebayUserId || store.name,
      sellerId: store.ebayUserId,
      related: s.modules.description.enabled && s.modules.description.showRelated ? await findRelated(store._id, item, s.modules.description.relatedCount) : [],
    },
  );
  const status = Object.keys(changes).length ? "proposed" : "no_change";
  const withFitment = evidence.references.filter((r) => r.rowCount > 0).length;
  const fitNote = evidence.partNumbers.length
    ? `part-number research: ${evidence.partNumbers.join(", ")} - ${evidence.references.length} other eBay listing(s) read (${withFitment} with fitment, ${evidence.specifics.length} distinct item specifics)`
    : "part-number research: no part number found in title/specifics";
  await Proposal.create({
    ...base,
    // keep the old description only when we're replacing it, so Revert can put it back
    ...(changes.description !== undefined ? { before: { ...snapshot, descriptionHtml: item.descriptionHtml ?? "" } } : {}),
    status,
    suggestion: { ...result.suggestion, suggested_compatibility_rows: suggestedCompat },
    shipping,
    fitment: {
      partNumbers: evidence.partNumbers,
      references: evidence.references,
      dropped: fit.dropped.slice(0, 50),
      existingCount: (item.compatibilityAll ?? item.compatibilitySample).length,
    },
    changes,
    notes: [
      `competitor query: "${query}" (${competitors.length} found)`,
      ...(aspectNote ? [aspectNote] : []),
      ...(s.modules.compatibility.enabled || s.modules.specifics.enabled ? [fitNote] : []),
      ...notes,
    ],
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
  const rows = await Proposal.find({ batchId, storeId: store._id, status: { $in: statuses } }).sort({ _id: 1 });
  await Batch.updateOne(
    { _id: batchId },
    {
      $set: {
        status: "pushing",
        push: { total: rows.length, done: 0, failed: 0, currentItemId: "", startedAt: new Date(), finishedAt: null },
      },
    },
  );
  for (const p of rows) {
    const changes = (p.changes ?? {}) as ListingChanges;
    if (!Object.keys(changes).length) {
      p.status = "no_change";
      await p.save();
      await Batch.updateOne({ _id: batchId }, { $inc: { "push.done": 1 } });
      continue;
    }
    await Batch.updateOne({ _id: batchId }, { $set: { "push.currentItemId": p.itemId } });
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
    await Batch.updateOne(
      { _id: batchId },
      { $inc: { "push.done": 1, "push.failed": p.status === "failed" ? 1 : 0 } },
    );
    await recountBatch(batchId);
    await deps.sleep(s.gapBetweenPushesSec * 1000);
  }
  await recountBatch(batchId);
  const pending = await Proposal.countDocuments({ batchId, status: { $in: ["proposed", "approved"] } });
  await Batch.updateOne(
    { _id: batchId },
    {
      $set: {
        status: pending ? "review" : "done",
        finishedAt: new Date(),
        "push.currentItemId": "",
        "push.finishedAt": new Date(),
      },
    },
  );
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
  // eBay's <Quantity> is the listing total (available + sold); changes.quantity is stored the same way
  if (changes.quantity !== undefined) revert.quantity = before.quantity;
  if (changes.description !== undefined && before.descriptionHtml !== undefined) revert.description = before.descriptionHtml;
  // a manual fitment edit replaced the whole list -> put the old list back (only possible if we saved it)
  if (changes.compatibilityReplace && before.compatibilityAll) revert.compatibilityReplace = before.compatibilityAll;
  if (changes.shippingPolicyId && before.shipping?.policyId) revert.shippingPolicyId = before.shipping.policyId;
  if (changes.packageDetails && before.shipping?.package) revert.packageDetails = before.shipping.package;
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
