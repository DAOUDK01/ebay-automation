/** Types for the Finances module API (backend src/modules/finances). */

export const TRANSACTION_TYPES = ["SALE", "REFUND", "CREDIT", "DISPUTE", "SHIPPING_LABEL", "TRANSFER", "NON_SALE_CHARGE"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TYPE_LABEL: Record<string, string> = {
  SALE: "Sale",
  REFUND: "Refund",
  CREDIT: "Credit",
  DISPUTE: "Dispute",
  SHIPPING_LABEL: "Shipping label",
  TRANSFER: "Transfer",
  NON_SALE_CHARGE: "Fee / charge",
};

export interface SyncInfo {
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  summary: string;
  error: string;
}

export interface Funds {
  currency: string;
  totalFunds: number;
  availableFunds: number;
  processingFunds: number;
  fundsOnHold: number;
  fetchedAt: string;
}

export interface Payout {
  payoutId: string;
  status: string;
  payoutDate: string;
  amount: number;
  currency: string;
  instrument?: { nickname?: string; last4?: string; type?: string };
  transactionCount: number;
  memo?: string;
}

export interface FinancesSummary {
  funds: Funds | null;
  lastPayout: Payout | null;
  transactionCount: number;
  sync: SyncInfo | null;
  needsDigitalSignature: boolean;
  marketplaceId: string;
}

export interface Transaction {
  _id: string;
  transactionId: string;
  type: string;
  status?: string;
  date: string;
  amount: number;
  currency: string;
  feeTotal: number;
  feeType?: string;
  orderId?: string;
  payoutId?: string;
  buyer?: string;
  memo?: string;
  itemIds: string[];
  lines: { itemId?: string; quantity: number; title?: string; fees: { feeType?: string; amount: number }[] }[];
}

export interface TransactionsPage {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
  totals: { amount: number; fees: number };
}

export interface PayoutDetail {
  payout: Payout;
  transactions: Transaction[];
  byType: Record<string, { count: number; amount: number }>;
}

export interface OrderProfit {
  orderId: string;
  date: string;
  buyer?: string;
  currency: string;
  items: { itemId: string | null; title?: string; quantity: number; unitCost: number | null }[];
  saleTotal: number;
  fees: number;
  shippingLabels: number;
  refunds: number;
  itemCost: number;
  profit: number;
  margin: number | null;
  missingCost: boolean;
}

export interface ProfitPage {
  items: OrderProfit[];
  total: number;
  page: number;
  pageSize: number;
  from: string;
  to: string;
  currency: string;
  totals: {
    orders: number;
    saleTotal: number;
    fees: number;
    shippingLabels: number;
    refunds: number;
    itemCost: number;
    profit: number;
    missingCost: number;
  };
}

export interface MonthPnl {
  month: string;
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
