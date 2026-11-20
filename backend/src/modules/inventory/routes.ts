/** /api/stores/:storeId/inventory - stock lists, bulk quantity/price edit, relist, end. Writes only on a user click. */
import { Router } from "express";
import { z } from "zod";
import { clientsFor } from "../../lib/ebay/sell";
import { loadStore } from "../../middleware/auth";
import { HttpError, parseBody } from "../../middleware/error";
import { Listing } from "../../models/Listing";
import type { StoreDocument } from "../../models/Store";
import { END_REASONS, endItem, relistItem, reviseInventory, type StockChange, type Trading } from "./ebay";
import { InventoryItem, inventorySettings } from "./model";
import { TABS, tabFilter, type Tab } from "./service";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PAGE_SIZE = 50;

export function inventoryRouter(tradingFor: (store: StoreDocument) => Trading = (s) => clientsFor(s).trading) {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const store = await loadStore(req);
    const { lowStockThreshold } = await inventorySettings(store._id);
    const tab: Tab = (TABS as readonly string[]).includes(String(req.query.tab)) ? (req.query.tab as Tab) : "active";
    const q = String(req.query.q ?? "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    // a search looks across every tab
    const filter: Record<string, any> = q ? { storeId: store._id } : tabFilter(store._id, tab, lowStockThreshold);
    if (q) {
      const rx = { $regex: esc(q), $options: "i" };
      filter.$or = [{ sku: rx }, { title: rx }, { itemId: q }];
    }
    const sort: Record<string, 1 | -1> =
      tab === "ended" && !q ? { endTime: -1 } : tab === "active" || q ? { quantityAvailable: 1, title: 1 } : { quantitySold: -1, title: 1 };
    const [items, total, tabCounts] = await Promise.all([
      InventoryItem.find(filter).sort(sort).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      InventoryItem.countDocuments(filter),
      Promise.all(TABS.map((t) => InventoryItem.countDocuments(tabFilter(store._id, t, lowStockThreshold)))),
    ]);
    res.json({
      items,
      total,
      page,
      pageSize: PAGE_SIZE,
      tabs: Object.fromEntries(TABS.map((t, i) => [t, tabCounts[i]])),
      lowStockThreshold,
    });
  });

  router.get("/settings", async (req, res) => {
    const store = await loadStore(req);
    const s = await inventorySettings(store._id);
    res.json({ settings: { lowStockThreshold: s.lowStockThreshold } });
  });

  router.put("/settings", async (req, res) => {
    const store = await loadStore(req);
    const body = parseBody(z.object({ lowStockThreshold: z.number().int().min(0).max(1000) }), req.body);
    const s = await inventorySettings(store._id);
    s.lowStockThreshold = body.lowStockThreshold;
    await s.save();
    res.json({ settings: { lowStockThreshold: s.lowStockThreshold } });
  });

  /** Bulk quantity / price edit (ReviseInventoryStatus, 4 per call). Reports a result per item. */
  router.post("/revise", async (req, res) => {
    const store = await loadStore(req);
    const body = parseBody(
      z.object({
        changes: z
          .array(
            z
              .object({
                itemId: z.string().min(1),
                quantity: z.number().int().min(0).max(100000).optional(),
                price: z.number().positive().max(1_000_000).optional(),
              })
              .refine((c) => c.quantity !== undefined || c.price !== undefined, "Change quantity or price"),
          )
          .min(1)
          .max(200),
      }),
      req.body,
    );
    const ids = body.changes.map((c) => c.itemId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "Each item can only appear once");
    const known = await InventoryItem.find({ storeId: store._id, itemId: { $in: ids } }).lean();
    const results: any[] = [];
    const send: StockChange[] = [];
    for (const c of body.changes) {
      const it = known.find((k) => k.itemId === c.itemId);
      if (!it) results.push({ ...c, ok: false, error: "Not one of this store's items" });
      else if (it.status !== "active") results.push({ ...c, ok: false, error: "Listing has ended - relist it first" });
      else if (it.hasVariations) results.push({ ...c, ok: false, error: "Multi-variation listing - edit it on eBay" });
      else send.push(c);
    }
    const sent = send.length ? await reviseInventory(tradingFor(store), send) : [];
    for (const r of sent) {
      if (!r.ok) continue;
      const set: Record<string, number> = {};
      if (r.quantity !== undefined) {
        const it = known.find((k) => k.itemId === r.itemId)!;
        set.quantityAvailable = r.quantity;
        set.quantity = r.quantity + (it.quantitySold ?? 0);
      }
      if (r.price !== undefined) set.price = r.price;
      await InventoryItem.updateOne({ storeId: store._id, itemId: r.itemId }, { $set: set });
      if (r.price !== undefined) await Listing.updateOne({ storeId: store._id, itemId: r.itemId }, { $set: { price: r.price } });
    }
    const all = [...results, ...sent];
    const ordered = ids.map((id) => all.find((r) => r.itemId === id));
    res.json({ results: ordered, ok: ordered.filter((r) => r.ok).length, failed: ordered.filter((r) => !r.ok).length });
  });

  router.post("/:itemId/relist", async (req, res) => {
    const store = await loadStore(req);
    const it = await InventoryItem.findOne({ storeId: store._id, itemId: req.params.itemId });
    if (!it) throw new HttpError(404, "Item not found");
    if (it.status === "active") throw new HttpError(400, "This listing is still active");
    if (it.relistedAs) throw new HttpError(400, `Already relisted as ${it.relistedAs}`);
    const newId = await relistItem(tradingFor(store), it.itemId, it.listingType);
    it.relistedAs = newId;
    await it.save();
    const quantity = Math.max(1, it.quantity - it.quantitySold);
    await InventoryItem.updateOne(
      { storeId: store._id, itemId: newId },
      {
        $set: {
          title: it.title, sku: it.sku, imageUrl: it.imageUrl, listingType: it.listingType, price: it.price, currency: it.currency,
          quantity, quantityAvailable: quantity, quantitySold: 0, watchers: 0, status: "active",
          hasVariations: it.hasVariations, startTime: new Date(), endTime: null, url: "",
        },
      },
      { upsert: true },
    );
    res.json({ itemId: it.itemId, newItemId: newId });
  });

  router.post("/:itemId/end", async (req, res) => {
    const store = await loadStore(req);
    const body = parseBody(z.object({ reason: z.enum(END_REASONS) }), req.body);
    const it = await InventoryItem.findOne({ storeId: store._id, itemId: req.params.itemId });
    if (!it) throw new HttpError(404, "Item not found");
    if (it.status !== "active") throw new HttpError(400, "This listing has already ended");
    const endTime = await endItem(tradingFor(store), it.itemId, body.reason, it.listingType);
    it.status = "ended";
    it.quantityAvailable = 0;
    it.endTime = endTime ?? new Date();
    await it.save();
    await Listing.updateOne({ storeId: store._id, itemId: it.itemId }, { $set: { active: false } });
    res.json({ item: it });
  });

  return router;
}
