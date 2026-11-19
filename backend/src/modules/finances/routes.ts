/** /api/stores/:storeId/finances - read-only views of synced Finances data. */
import { Router, type Request } from "express";
import type { Types } from "mongoose";
import { loadStore } from "../../middleware/auth";
import { HttpError } from "../../middleware/error";
import { Listing } from "../../models/Listing";
import { SyncState } from "../../models/SyncState";
import { needsDigitalSignature } from "./client";
import { computeOrderProfits, monthlyPnl, TRANSACTION_TYPES, transactionsCsv, type ListingCost } from "./logic";
import { FinTransaction, FundsSummary, Payout } from "./models";

const router = Router({ mergeParams: true });
const DAY = 86_400_000;

const page = (req: Request, size = 25) => {
  const p = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || size));
  return { page: p, pageSize, skip: (p - 1) * pageSize };
};

const parseDate = (v: unknown, endOfDay = false) => {
  if (!v) return undefined;
  const d = new Date(String(v) + (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z") : ""));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid date: ${v}`);
  return d;
};

/** Mongo filter from ?type=SALE&from=YYYY-MM-DD&to=YYYY-MM-DD&q=order-or-buyer */
function txFilter(storeId: Types.ObjectId, req: Request) {
  const f: any = { storeId };
  const type = String(req.query.type ?? "");
  if (type) {
    if (!(TRANSACTION_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Unknown transaction type");
    f.type = type;
  }
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if (from || to) f.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const q = String(req.query.q ?? "").trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    f.$or = [{ orderId: rx }, { buyer: rx }, { transactionId: rx }, { itemIds: q }];
  }
  return f;
}

/** Transactions + listing costs for the profit maths over a date range. */
async function profitData(storeId: Types.ObjectId, from: Date, to: Date) {
  const txs = await FinTransaction.find({ storeId, date: { $gte: from, $lte: to } }).sort({ date: -1 }).lean();
  const itemIds = [...new Set(txs.flatMap((t) => [...(t.itemIds ?? []), ...(t.lines ?? []).map((l) => l.itemId)]).filter(Boolean))] as string[];
  const listings = await Listing.find({ storeId, itemId: { $in: itemIds } }, { itemId: 1, cost: 1, title: 1 }).lean();
  const costs = new Map<string, ListingCost>(listings.map((l) => [l.itemId, { cost: l.cost ?? null, title: l.title ?? undefined }]));
  const plain = txs.map((t) => ({ ...t, orderId: t.orderId ?? undefined, buyer: t.buyer ?? undefined, lines: (t.lines ?? []).map((l) => ({ itemId: l.itemId ?? undefined, quantity: l.quantity ?? 1, title: l.title ?? undefined })) }));
  return { txs: plain, profits: computeOrderProfits(plain, costs) };
}

router.get("/summary", async (req, res) => {
  const store = await loadStore(req);
  const [funds, state, lastPayout, txCount] = await Promise.all([
    FundsSummary.findOne({ storeId: store._id }).lean(),
    SyncState.findOne({ storeId: store._id, module: "finances" }).lean(),
    Payout.findOne({ storeId: store._id }).sort({ payoutDate: -1 }).lean(),
    FinTransaction.countDocuments({ storeId: store._id }),
  ]);
  res.json({
    funds,
    lastPayout,
    transactionCount: txCount,
    sync: state ? { lastSuccessAt: state.lastSuccessAt, lastRunAt: state.lastRunAt, summary: state.summary, error: state.error } : null,
    needsDigitalSignature: needsDigitalSignature(store.marketplaceId),
    marketplaceId: store.marketplaceId,
  });
});

router.get("/payouts", async (req, res) => {
  const store = await loadStore(req);
  const { page: p, pageSize, skip } = page(req);
  const [items, total] = await Promise.all([
    Payout.find({ storeId: store._id }).sort({ payoutDate: -1 }).skip(skip).limit(pageSize).lean(),
    Payout.countDocuments({ storeId: store._id }),
  ]);
  res.json({ items, total, page: p, pageSize });
});

router.get("/payouts/:payoutId", async (req, res) => {
  const store = await loadStore(req);
  const payout = await Payout.findOne({ storeId: store._id, payoutId: String(req.params.payoutId) }).lean();
  if (!payout) throw new HttpError(404, "Payout not found");
  const transactions = await FinTransaction.find({ storeId: store._id, payoutId: payout.payoutId }).sort({ date: -1 }).lean();
  const byType: Record<string, { count: number; amount: number }> = {};
  for (const t of transactions) {
    const b = (byType[t.type] ??= { count: 0, amount: 0 });
    b.count++;
    b.amount = Math.round((b.amount + (t.amount ?? 0)) * 100) / 100;
  }
  res.json({ payout, transactions, byType });
});

router.get("/transactions", async (req, res) => {
  const store = await loadStore(req);
  const { page: p, pageSize, skip } = page(req, 50);
  const f = txFilter(store._id, req);
  const [items, total, sums] = await Promise.all([
    FinTransaction.find(f).sort({ date: -1 }).skip(skip).limit(pageSize).lean(),
    FinTransaction.countDocuments(f),
    FinTransaction.aggregate([{ $match: f }, { $group: { _id: null, amount: { $sum: "$amount" }, fees: { $sum: "$feeTotal" } } }]),
  ]);
  res.json({ items, total, page: p, pageSize, totals: { amount: sums[0]?.amount ?? 0, fees: sums[0]?.fees ?? 0 } });
});

/** Same filters as /transactions, every row, as CSV. */
router.get("/transactions.csv", async (req, res) => {
  const store = await loadStore(req);
  const rows = await FinTransaction.find(txFilter(store._id, req)).sort({ date: -1 }).limit(100_000).lean();
  const name = `transactions-${store.ebayUserId}-${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^\w.-]/g, "_");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(transactionsCsv(rows));
});

/** Profit per order. ?from&to (default last 90 days), ?missing=1 = only orders without a cost. */
router.get("/profit", async (req, res) => {
  const store = await loadStore(req);
  const to = parseDate(req.query.to, true) ?? new Date();
  const from = parseDate(req.query.from) ?? new Date(to.getTime() - 90 * DAY);
  const { page: p, pageSize, skip } = page(req, 25);
  const { profits } = await profitData(store._id, from, to);
  const list = req.query.missing === "1" ? profits.filter((o) => o.missingCost) : profits;
  const sum = (k: "saleTotal" | "fees" | "shippingLabels" | "refunds" | "itemCost" | "profit") =>
    Math.round(profits.reduce((s, o) => s + o[k], 0) * 100) / 100;
  res.json({
    items: list.slice(skip, skip + pageSize),
    total: list.length,
    page: p,
    pageSize,
    from,
    to,
    totals: {
      orders: profits.length,
      saleTotal: sum("saleTotal"),
      fees: sum("fees"),
      shippingLabels: sum("shippingLabels"),
      refunds: sum("refunds"),
      itemCost: sum("itemCost"),
      profit: sum("profit"),
      missingCost: profits.filter((o) => o.missingCost).length,
    },
    currency: profits[0]?.currency ?? "USD",
  });
});

/** Monthly profit & loss for the last ?months (default 12). */
router.get("/pnl", async (req, res) => {
  const store = await loadStore(req);
  const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const { txs, profits } = await profitData(store._id, from, now);
  res.json({ months: monthlyPnl(txs, profits), currency: txs[0]?.currency ?? "USD" });
});

export default router;
