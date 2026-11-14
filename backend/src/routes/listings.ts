import { Router } from "express";
import { z } from "zod";
import { loadStore } from "../middleware/auth";
import { HttpError, parseBody } from "../middleware/error";
import { Listing } from "../models/Listing";
import { Proposal } from "../models/Proposal";
import { computeManualChanges } from "../services/listingEdit";
import { defaultDeps } from "../services/pipeline";

const router = Router({ mergeParams: true });

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.get("/", async (req, res) => {
  const store = await loadStore(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
  const q = String(req.query.q ?? "").trim();
  const filter: Record<string, unknown> = { storeId: store._id, active: req.query.inactive === "1" ? false : true };
  if (q) filter.$or = [{ title: new RegExp(escapeRegex(q), "i") }, { itemId: q }, { sku: q }];
  if (req.query.status === "never") filter.lastProcessedAt = null;
  if (req.query.status === "processed") filter.lastProcessedAt = { $ne: null };
  if (req.query.status === "nocost") filter.cost = null;
  const sortKey = String(req.query.sort ?? "lastProcessedAt");
  const sort: Record<string, 1 | -1> =
    sortKey === "price" ? { price: -1 } : sortKey === "sold" ? { quantitySold: -1 } : sortKey === "title" ? { title: 1 } : { lastProcessedAt: -1 };
  const [items, total] = await Promise.all([
    Listing.find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Listing.countDocuments(filter),
  ]);
  res.json({ items, total, page, pageSize });
});

/** Full listing, live from eBay (photos, description, specifics, full fitment) + the category's aspects for editing. */
router.get("/:itemId/details", async (req, res) => {
  const store = await loadStore(req);
  const itemId = String(req.params.itemId);
  const listing = await Listing.findOne({ storeId: store._id, itemId }).lean();
  if (!listing) throw new HttpError(404, "Listing not found");
  const deps = defaultDeps(store);
  let item;
  try {
    item = await deps.trading.getItem(itemId);
  } catch (e: any) {
    throw new HttpError(502, `Couldn't load the listing from eBay: ${e?.message ?? e}`);
  }
  let aspects: { name: string; required: boolean; usage: string; mode: string; multi: boolean; values: string[] }[] = [];
  try {
    aspects = (await deps.rest.aspectsForCategory(item.categoryId)).map((a) => ({ ...a, values: a.values.slice(0, 200) }));
  } catch {
    /* edit page still works without suggestions */
  }
  res.json({ item, listing, aspects });
});

const manualEditSchema = z.object({
  title: z.string().max(200).optional(),
  price: z.number().optional(),
  quantityAvailable: z.number().int().min(0).max(100000).optional(),
  description: z.string().max(600_000).optional(),
  itemSpecifics: z.record(z.string(), z.array(z.string().max(200)).max(100)).optional(),
  compatibility: z
    .array(
      z.object({
        Year: z.string().max(10),
        Make: z.string().max(100),
        Model: z.string().max(100),
        Trim: z.string().max(200).optional(),
        Engine: z.string().max(200).optional(),
      }),
    )
    .max(5000)
    .optional(),
});

/** Save manual edits straight to eBay; recorded in Change history (revertable). */
router.put("/:itemId", async (req, res) => {
  const store = await loadStore(req);
  const itemId = String(req.params.itemId);
  const body = parseBody(manualEditSchema, req.body);
  if (!(await Listing.exists({ storeId: store._id, itemId }))) throw new HttpError(404, "Listing not found");
  const deps = defaultDeps(store);
  const before = await deps.trading.getItem(itemId); // fresh snapshot = what revert restores
  let changes;
  try {
    changes = computeManualChanges(before, body);
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  if (!Object.keys(changes).length) throw new HttpError(400, "Nothing changed");

  let warnings: string[] = [];
  try {
    warnings = await deps.trading.reviseItem(itemId, changes, before.site);
  } catch (e: any) {
    throw new HttpError(400, `eBay rejected the update: ${e?.message ?? e}`);
  }
  const proposal = await Proposal.create({
    storeId: store._id,
    batchId: null,
    kind: "manual",
    itemId,
    status: "pushed",
    before,
    changes,
    notes: [`manual edit: ${Object.keys(changes).join(", ")}`],
    warnings,
    pushedAt: new Date(),
  });
  const set: Record<string, unknown> = {};
  if (changes.title) set.title = changes.title;
  if (changes.price) set.price = changes.price;
  if (Object.keys(set).length) await Listing.updateOne({ storeId: store._id, itemId }, { $set: set });
  res.json({ proposalId: String(proposal._id), changed: Object.keys(changes), warnings });
});

/** Full change history for one listing */
router.get("/:itemId/history", async (req, res) => {
  const store = await loadStore(req);
  const proposals = await Proposal.find({ storeId: store._id, itemId: req.params.itemId })
    .sort({ createdAt: -1 })
    .limit(50)
    .select("-before.descriptionText -competitors")
    .lean();
  res.json({ proposals });
});

router.patch("/:itemId", async (req, res) => {
  const store = await loadStore(req);
  const { cost } = parseBody(z.object({ cost: z.number().min(0).nullable() }), req.body);
  const l = await Listing.findOneAndUpdate({ storeId: store._id, itemId: req.params.itemId }, { $set: { cost } }, { new: true });
  if (!l) throw new HttpError(404, "Listing not found");
  res.json({ listing: l });
});

/** Bulk import costs. CSV text with header `id,cost` - id is an eBay ItemID or your SKU. */
router.post("/costs", async (req, res) => {
  const store = await loadStore(req);
  const { csv } = parseBody(z.object({ csv: z.string().min(3).max(5_000_000) }), req.body);
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let updated = 0;
  const unmatched: string[] = [];
  const invalid: string[] = [];
  for (const line of lines) {
    const [rawId, rawCost] = line.split(/[,;\t]/).map((x) => x?.trim().replace(/^"|"$/g, ""));
    if (!rawId || /^(id|itemid|sku)$/i.test(rawId)) continue;
    const cost = Number(rawCost);
    if (!Number.isFinite(cost) || cost < 0) {
      invalid.push(line);
      continue;
    }
    const r = await Listing.updateMany({ storeId: store._id, $or: [{ itemId: rawId }, { sku: rawId }] }, { $set: { cost } });
    if (r.matchedCount) updated += r.modifiedCount || r.matchedCount;
    else unmatched.push(rawId);
  }
  res.json({ updated, unmatched: unmatched.slice(0, 200), unmatchedCount: unmatched.length, invalid: invalid.slice(0, 50) });
});

export default router;
