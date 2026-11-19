/** Background refresh: funds summary, payouts and transactions (incremental by date, with an overlap window). */
import type { Types } from "mongoose";
import type { SyncContext, SyncResult } from "../types";
import { FinancesClient, needsDigitalSignature, type FinancesApi } from "./client";
import { dateFilter, mapPayout, mapTransaction, typeFilter } from "./logic";
import { FinTransaction, FundsSummary, Payout } from "./models";

export interface FinancesCursor {
  payoutDate?: string;
  transactionDate?: string;
}

const DAY = 86_400_000;
/** first sync looks this far back */
export const INITIAL_DAYS = 180;
/** re-read this much before the cursor: payout status and transaction status/payoutId change after the fact */
export const PAYOUT_OVERLAP_DAYS = 7;
export const TX_OVERLAP_DAYS = 14;

const FULFILLMENT_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment";
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** ctx.clients.finances lets tests inject a fake; otherwise a client on apiz.ebay.com with the account's token. */
export const financesApi = (ctx: SyncContext): FinancesApi => (ctx.clients as any).finances ?? FinancesClient.fromSell(ctx.clients.sell);

const later = (a: Date | null, b: Date | undefined) => (b && (!a || b > a) ? b : a);

async function upsertTransactions(storeId: Types.ObjectId, raws: any[]) {
  if (!raws.length) return 0;
  const mapped = raws.map(mapTransaction);
  // keep item ids / quantities we already filled in from the order
  const enriched = new Set(
    (await FinTransaction.find({ storeId, enriched: true, transactionId: { $in: mapped.map((m) => m.transactionId) } }, { transactionId: 1, type: 1 }).lean()).map(
      (t) => `${t.transactionId}|${t.type}`,
    ),
  );
  await FinTransaction.bulkWrite(
    mapped.map((m) => {
      const { lines, itemIds, ...rest } = m;
      const set = enriched.has(`${m.transactionId}|${m.type}`) ? rest : m;
      return { updateOne: { filter: { storeId, transactionId: m.transactionId, type: m.type }, update: { $set: set }, upsert: true } };
    }),
  );
  return mapped.length;
}

/** Fill item ids + quantities on sales from the Fulfillment API (Finances doesn't report them). Best effort. */
export async function enrichSales(ctx: SyncContext, limit = 200): Promise<number> {
  if (!(ctx.store.auth?.scopes ?? []).includes(FULFILLMENT_SCOPE)) return 0;
  const sales = await FinTransaction.find({ storeId: ctx.store._id, type: "SALE", enriched: false, orderId: { $exists: true, $ne: null } })
    .sort({ date: -1 })
    .limit(limit)
    .lean();
  let done = 0;
  for (let i = 0; i < sales.length; i += 50) {
    const chunk = sales.slice(i, i + 50);
    let orders: any[] = [];
    try {
      const r: any = await ctx.clients.sell.get("/sell/fulfillment/v1/order", { orderIds: chunk.map((s) => s.orderId).join(",") });
      orders = r?.orders ?? [];
    } catch (e: any) {
      ctx.log(`couldn't read orders for item costs: ${e?.message ?? e}`);
      return done;
    }
    for (const s of chunk) {
      const o = orders.find((x) => x.orderId === s.orderId);
      if (!o) continue;
      const byLine = new Map<string, any>((o.lineItems ?? []).map((l: any) => [String(l.lineItemId), l]));
      const lines = (s.lines?.length ? s.lines : (o.lineItems ?? []).map((l: any) => ({ lineItemId: l.lineItemId, feeBasis: 0, fees: [] }))).map(
        (l: any) => {
          const ol = byLine.get(String(l.lineItemId));
          return ol ? { ...l, itemId: ol.legacyItemId ?? l.itemId, quantity: num(ol.quantity) || 1, title: ol.title } : l;
        },
      );
      await FinTransaction.updateOne(
        { _id: s._id },
        { $set: { lines, itemIds: [...new Set(lines.map((l: any) => l.itemId).filter(Boolean))], enriched: true } },
      );
      done++;
    }
  }
  return done;
}

export async function syncFinances(ctx: SyncContext, api: FinancesApi = financesApi(ctx)): Promise<SyncResult> {
  if (needsDigitalSignature(ctx.store.marketplaceId)) {
    return {
      cursor: ctx.cursor ?? undefined,
      summary: "Skipped: eBay requires digital signatures for EU/UK accounts (not supported yet)",
    };
  }
  const storeId = ctx.store._id;
  const cur: FinancesCursor = ctx.cursor ?? {};
  const now = Date.now();

  // 1. funds
  const f: any = await api.get("/sell/finances/v1/seller_funds_summary");
  await FundsSummary.updateOne(
    { storeId },
    {
      $set: {
        currency: f?.availableFunds?.currency || f?.totalFunds?.currency || "USD",
        totalFunds: num(f?.totalFunds?.value),
        availableFunds: num(f?.availableFunds?.value),
        processingFunds: num(f?.processingFunds?.value),
        fundsOnHold: num(f?.fundsOnHold?.value),
        fetchedAt: new Date(),
      },
    },
    { upsert: true },
  );

  // 2. payouts since the cursor (minus overlap)
  const payoutFrom = cur.payoutDate ? new Date(new Date(cur.payoutDate).getTime() - PAYOUT_OVERLAP_DAYS * DAY) : new Date(now - INITIAL_DAYS * DAY);
  let newestPayout: Date | null = cur.payoutDate ? new Date(cur.payoutDate) : null;
  const changedPayouts: string[] = [];
  let payouts = 0;
  for await (const raw of api.paged("/sell/finances/v1/payout", "payouts", { filter: dateFilter("payoutDate", payoutFrom), sort: "payoutDate" })) {
    const p = mapPayout(raw);
    const prev = await Payout.findOneAndUpdate({ storeId, payoutId: p.payoutId }, { $set: p }, { upsert: true }).lean();
    if (!prev || prev.status !== p.status || prev.transactionCount !== p.transactionCount) changedPayouts.push(p.payoutId);
    newestPayout = later(newestPayout, p.payoutDate);
    payouts++;
  }

  // 3. transactions since the cursor (minus overlap)
  const txFrom = cur.transactionDate ? new Date(new Date(cur.transactionDate).getTime() - TX_OVERLAP_DAYS * DAY) : new Date(now - INITIAL_DAYS * DAY);
  let newestTx: Date | null = cur.transactionDate ? new Date(cur.transactionDate) : null;
  let batch: any[] = [];
  let txs = 0;
  for await (const raw of api.paged("/sell/finances/v1/transaction", "transactions", {
    filter: `${dateFilter("transactionDate", txFrom)},${typeFilter()}`,
    sort: "transactionDate",
  })) {
    batch.push(raw);
    newestTx = later(newestTx, raw.transactionDate ? new Date(raw.transactionDate) : undefined);
    if (batch.length >= 200) {
      txs += await upsertTransactions(storeId, batch);
      batch = [];
    }
  }
  txs += await upsertTransactions(storeId, batch);

  // 4. new / changed payouts: read exactly which transactions they contain (older ones get their payoutId here)
  for (const payoutId of changedPayouts) {
    const rows: any[] = [];
    for await (const raw of api.paged("/sell/finances/v1/transaction", "transactions", { filter: `payoutId:{${payoutId}}` })) rows.push(raw);
    await upsertTransactions(storeId, rows);
  }

  // 5. item ids + quantities for profit
  const enriched = await enrichSales(ctx);

  return {
    cursor: { payoutDate: newestPayout?.toISOString(), transactionDate: newestTx?.toISOString() } satisfies FinancesCursor,
    summary: `${txs} transactions, ${payouts} payouts${enriched ? `, ${enriched} sales matched to items` : ""}`,
  };
}
