/** Pure Finances helpers: map eBay payloads, profit per order, monthly P&L, CSV. No database or network here. */

export const TRANSACTION_TYPES = ["SALE", "REFUND", "CREDIT", "DISPUTE", "SHIPPING_LABEL", "TRANSFER", "NON_SALE_CHARGE"] as const;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MappedPayout {
  payoutId: string;
  status?: string;
  payoutDate?: Date;
  lastAttemptedPayoutDate?: Date;
  amount: number;
  currency: string;
  instrument: { nickname?: string; last4?: string; type?: string };
  transactionCount: number;
  memo?: string;
}

/** eBay Payout -> our model fields. */
export function mapPayout(p: any): MappedPayout {
  return {
    payoutId: String(p.payoutId),
    status: p.payoutStatus,
    payoutDate: p.payoutDate ? new Date(p.payoutDate) : undefined,
    lastAttemptedPayoutDate: p.lastAttemptedPayoutDate ? new Date(p.lastAttemptedPayoutDate) : undefined,
    amount: num(p.amount?.value),
    currency: p.amount?.currency || "USD",
    instrument: {
      nickname: p.payoutInstrument?.nickname,
      last4: p.payoutInstrument?.accountLastFourDigits,
      type: p.payoutInstrument?.instrumentType,
    },
    transactionCount: num(p.transactionCount),
    memo: p.payoutMemo,
  };
}

export interface TxLine {
  lineItemId?: string;
  itemId?: string;
  quantity: number;
  title?: string;
  feeBasis: number;
  fees: { feeType?: string; amount: number; memo?: string }[];
}

export interface MappedTransaction {
  transactionId: string;
  type: string;
  status?: string;
  date: Date;
  bookingEntry?: string;
  amount: number;
  currency: string;
  feeTotal: number;
  feeBasis: number;
  feeType?: string;
  orderId?: string;
  payoutId?: string;
  buyer?: string;
  memo?: string;
  itemIds: string[];
  lines: TxLine[];
}

/** eBay Transaction -> our model fields. `amount` becomes signed (DEBIT = negative). */
export function mapTransaction(t: any): MappedTransaction {
  const sign = t.bookingEntry === "DEBIT" ? -1 : 1;
  const refs: any[] = t.references ?? [];
  const ref = (type: string) => refs.filter((r) => r?.referenceType === type).map((r) => String(r.referenceId));
  const itemIds = [...new Set(ref("ITEM_ID"))];
  const lines: TxLine[] = (t.orderLineItems ?? []).map((l: any) => ({
    lineItemId: l.lineItemId,
    itemId: l.itemId ?? l.legacyItemId,
    quantity: num(l.quantity) || 1,
    feeBasis: num(l.feeBasisAmount?.value),
    fees: (l.marketplaceFees ?? []).map((f: any) => ({ feeType: f.feeType, amount: num(f.amount?.value), memo: f.feeMemo })),
  }));
  // a single-line sale with one ITEM_ID reference: that's the line's item
  if (lines.length === 1 && !lines[0].itemId && itemIds.length === 1) lines[0].itemId = itemIds[0];
  const lineFees = lines.reduce((s, l) => s + l.fees.reduce((a, f) => a + f.amount, 0), 0);
  return {
    transactionId: String(t.transactionId),
    type: t.transactionType,
    status: t.transactionStatus,
    date: new Date(t.transactionDate),
    bookingEntry: t.bookingEntry,
    amount: round2(sign * num(t.amount?.value)),
    currency: t.amount?.currency || "USD",
    // `amount` is net of ALL fees, so the order-level total is the right one to add back; lines may miss some
    feeTotal: round2(num(t.totalFeeAmount?.value) || lineFees),
    feeBasis: num(t.totalFeeBasisAmount?.value),
    feeType: t.feeType,
    orderId: t.orderId ?? ref("ORDER_ID")[0],
    payoutId: t.payoutId,
    buyer: t.buyer?.username,
    memo: t.transactionMemo,
    itemIds,
    lines,
  };
}

/** eBay filter for getTransactions / getPayouts: `field:[from..]` (ISO dates). */
export const dateFilter = (field: string, from: Date) => `${field}:[${from.toISOString()}..]`;
export const typeFilter = () => `transactionType:{${TRANSACTION_TYPES.join("|")}}`;

// ---------------------------------------------------------------- profit per order

/** The bits of a stored transaction the profit maths needs. */
export interface TxForProfit {
  type: string;
  date: Date | string;
  amount: number;
  feeTotal: number;
  currency?: string;
  orderId?: string;
  buyer?: string;
  itemIds?: string[];
  lines?: { itemId?: string; quantity?: number; title?: string }[];
}

export interface ListingCost {
  cost: number | null | undefined;
  title?: string;
}

export interface OrderProfit {
  orderId: string;
  date: string;
  buyer?: string;
  currency: string;
  items: { itemId: string | null; title?: string; quantity: number; unitCost: number | null }[];
  /** what the buyer paid you before fees (net payout + fees; sales tax collected by eBay excluded) */
  saleTotal: number;
  /** final value fees + other eBay charges tied to the order (e.g. promoted listing ad fee) */
  fees: number;
  shippingLabels: number;
  refunds: number;
  itemCost: number;
  profit: number;
  /** profit / saleTotal, 0..1 */
  margin: number | null;
  /** at least one item has no cost entered: profit is overstated */
  missingCost: boolean;
}

/**
 * profit = sale total - eBay fees - shipping label cost - refunds - Listing.cost x quantity.
 * Orders with an item whose cost isn't known are flagged (`missingCost`) and counted with cost 0.
 */
export function computeOrderProfits(txs: TxForProfit[], costs: Map<string, ListingCost>): OrderProfit[] {
  const orders = new Map<string, OrderProfit & { hasSale: boolean }>();
  for (const t of txs) {
    if (!t.orderId) continue;
    let o = orders.get(t.orderId);
    if (!o) {
      o = {
        orderId: t.orderId,
        date: new Date(t.date).toISOString(),
        currency: t.currency || "USD",
        items: [],
        saleTotal: 0,
        fees: 0,
        shippingLabels: 0,
        refunds: 0,
        itemCost: 0,
        profit: 0,
        margin: null,
        missingCost: false,
        hasSale: false,
      };
      orders.set(t.orderId, o);
    }
    switch (t.type) {
      case "SALE": {
        o.hasSale = true;
        o.date = new Date(t.date).toISOString();
        o.buyer = t.buyer ?? o.buyer;
        o.saleTotal += t.amount + t.feeTotal;
        o.fees += t.feeTotal;
        const lines: { itemId?: string; quantity?: number; title?: string }[] = t.lines?.length ? t.lines : (t.itemIds ?? []).map((itemId) => ({ itemId, quantity: 1 }));
        if (!lines.length) o.items.push({ itemId: null, quantity: 1, unitCost: null });
        for (const l of lines) {
          const c = l.itemId ? costs.get(l.itemId) : undefined;
          const unitCost = c?.cost ?? null;
          o.items.push({ itemId: l.itemId ?? null, title: c?.title ?? l.title, quantity: l.quantity || 1, unitCost });
        }
        break;
      }
      case "SHIPPING_LABEL":
        o.shippingLabels -= t.amount; // labels are debits (negative); a voided label credit lowers the cost
        break;
      case "REFUND":
      case "DISPUTE":
        o.refunds -= t.amount;
        break;
      case "NON_SALE_CHARGE":
        o.fees -= t.amount;
        break;
      case "CREDIT":
        o.refunds -= t.amount; // a credit back on the order reduces what it cost you
        break;
    }
  }
  const out: OrderProfit[] = [];
  for (const { hasSale, ...o } of orders.values()) {
    if (!hasSale) continue;
    o.itemCost = o.items.reduce((s, i) => s + (i.unitCost ?? 0) * i.quantity, 0);
    o.missingCost = o.items.some((i) => i.unitCost === null);
    for (const k of ["saleTotal", "fees", "shippingLabels", "refunds", "itemCost"] as const) o[k] = round2(o[k]);
    o.profit = round2(o.saleTotal - o.fees - o.shippingLabels - o.refunds - o.itemCost);
    o.margin = o.saleTotal > 0 ? Math.round((o.profit / o.saleTotal) * 1000) / 1000 : null;
    out.push(o);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------- monthly P&L

export interface MonthPnl {
  month: string; // YYYY-MM
  orders: number;
  sales: number;
  fees: number;
  refunds: number;
  shippingLabels: number;
  credits: number;
  costOfGoods: number;
  net: number;
  missingCostOrders: number;
}

/** Monthly profit & loss from transactions (TRANSFERs aren't income or cost, so they're left out). */
export function monthlyPnl(txs: TxForProfit[], profits: OrderProfit[]): MonthPnl[] {
  const months = new Map<string, MonthPnl>();
  const m = (d: Date | string) => {
    const key = new Date(d).toISOString().slice(0, 7);
    let r = months.get(key);
    if (!r) {
      r = { month: key, orders: 0, sales: 0, fees: 0, refunds: 0, shippingLabels: 0, credits: 0, costOfGoods: 0, net: 0, missingCostOrders: 0 };
      months.set(key, r);
    }
    return r;
  };
  for (const t of txs) {
    const r = m(t.date);
    if (t.type === "SALE") {
      r.sales += t.amount + t.feeTotal;
      r.fees += t.feeTotal;
    } else if (t.type === "NON_SALE_CHARGE") r.fees -= t.amount;
    else if (t.type === "REFUND" || t.type === "DISPUTE") r.refunds -= t.amount;
    else if (t.type === "SHIPPING_LABEL") r.shippingLabels -= t.amount;
    else if (t.type === "CREDIT") r.credits += t.amount;
  }
  for (const p of profits) {
    const r = m(p.date);
    r.orders++;
    r.costOfGoods += p.itemCost;
    if (p.missingCost) r.missingCostOrders++;
  }
  return [...months.values()]
    .map((r) => {
      for (const k of ["sales", "fees", "refunds", "shippingLabels", "credits", "costOfGoods"] as const) r[k] = round2(r[k]);
      r.net = round2(r.sales - r.fees - r.refunds - r.shippingLabels + r.credits - r.costOfGoods);
      return r;
    })
    .sort((a, b) => b.month.localeCompare(a.month));
}

// ---------------------------------------------------------------- CSV

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  // quote, and neutralise spreadsheet formulas
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function transactionsCsv(rows: any[]): string {
  const head = ["date", "type", "status", "transaction_id", "order_id", "payout_id", "buyer", "item_ids", "amount", "fees", "currency", "fee_type", "memo"];
  const lines = rows.map((t) =>
    [t.date, t.type, t.status, t.transactionId, t.orderId, t.payoutId, t.buyer, (t.itemIds ?? []).join(" "), t.amount, t.feeTotal, t.currency, t.feeType, t.memo]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
