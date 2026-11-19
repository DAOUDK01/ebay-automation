/** Orders & shipping: types shared by the orders and shipping pages (backend src/modules/orders, shipping). */

export type OrderStatus = "awaiting_payment" | "awaiting_shipment" | "shipped" | "cancelled" | "refunded";
export type OrderFilter = "awaiting" | "shipped" | "cancelled" | "unpaid" | "all";

export interface OrderLine {
  lineItemId: string;
  itemId: string;
  title: string;
  sku: string;
  qty: number;
  price: number;
  total: number;
  image: string;
  fulfillmentStatus: string;
}

export interface Fulfillment {
  fulfillmentId: string;
  carrier: string;
  trackingNumber: string;
  shippedDate: string | null;
  lineItems: { lineItemId: string; qty: number }[];
}

export interface Refund {
  refundId: string;
  amount: number;
  currency: string;
  date: string | null;
  status: string;
  reason: string;
}

export interface Order {
  _id: string;
  orderId: string;
  legacyOrderId: string;
  status: OrderStatus;
  paymentStatus: string;
  fulfillmentStatus: string;
  cancelState: string;
  buyer: { username: string; name: string; email: string };
  shipTo: { name: string; line1: string; line2: string; city: string; state: string; postalCode: string; country: string; phone: string };
  lineItems: OrderLine[];
  totals: { subtotal: number; shipping: number; tax: number; discount: number; total: number; currency: string };
  fees: number | null;
  shippingService: string;
  shipByDate: string | null;
  buyerNotes: string;
  fulfillments: Fulfillment[];
  refunds: Refund[];
  creationDate: string;
  lastModifiedDate: string;
}

export interface OrderList {
  items: Order[];
  total: number;
  page: number;
  pageSize: number;
  tabs: Record<OrderFilter, number>;
}

export interface QueueOrder extends Order {
  overdue: boolean;
  dueSoon: boolean;
}

export interface BulkTrackingRow {
  line: number;
  input: string;
  orderId: string;
  buyer: string;
  title: string;
  carrier: string;
  trackingNumber: string;
  problem: string;
  ok: boolean;
  error: string;
}

export interface PolicyRef {
  id: string;
  name: string;
  kg: number | null;
}

export interface PolicyFix {
  itemId: string;
  title: string;
  imageUrl: string;
  price: number | null;
  current: PolicyRef | null;
  suggested: PolicyRef;
  note: string;
  billableKg: number;
  categoryKg: number;
  source: "listing" | "estimate" | "none";
  rule?: "part" | "weight";
  analysedAt: string;
  pendingInBatch: boolean;
}

export const ORDER_TABS: { key: OrderFilter; label: string }[] = [
  { key: "awaiting", label: "Awaiting shipment" },
  { key: "shipped", label: "Shipped" },
  { key: "cancelled", label: "Cancelled & refunded" },
  { key: "unpaid", label: "Awaiting payment" },
  { key: "all", label: "All" },
];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  awaiting_payment: "Awaiting payment",
  awaiting_shipment: "Awaiting shipment",
  shipped: "Shipped",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export const STATUS_COLOR: Record<OrderStatus, "yellow" | "blue" | "green" | "gray" | "red"> = {
  awaiting_payment: "gray",
  awaiting_shipment: "yellow",
  shipped: "green",
  cancelled: "gray",
  refunded: "red",
};

/** eBay shippingCarrierCode values offered in the tracking dialogs (anything else can be typed). */
export const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "OnTrac", "LaserShip", "CanadaPost", "RoyalMail", "Purolator", "AustraliaPost"];

export const REFUND_REASONS: { value: string; label: string }[] = [
  { value: "BUYER_CANCEL", label: "Buyer asked to cancel" },
  { value: "BUYER_RETURN", label: "Buyer returned the item" },
  { value: "ITEM_NOT_RECEIVED", label: "Item not received" },
  { value: "SELLER_WRONG_ITEM", label: "Wrong item sent" },
  { value: "SELLER_OUT_OF_STOCK", label: "Out of stock" },
  { value: "SELLER_FOUND_CHEAPER_PRICE", label: "Shipping/price adjustment" },
  { value: "OTHER", label: "Other" },
];

export const ebayOrderUrl = (orderId: string) => `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(orderId)}`;

export const itemsCount = (o: Order) => o.lineItems.reduce((s, l) => s + l.qty, 0);

export function addressLines(t: Order["shipTo"]): string[] {
  return [t.name, t.line1, t.line2, [t.city, [t.state, t.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", "), t.country].filter(Boolean);
}

/** "Due in 5h", "Overdue 2d", "Due Nov 22" */
export function shipByLabel(d: string | null): { text: string; overdue: boolean; soon: boolean } {
  if (!d) return { text: "—", overdue: false, soon: false };
  const ms = new Date(d).getTime() - Date.now();
  const h = Math.abs(ms) / 3600_000;
  const span = h < 24 ? `${Math.max(1, Math.round(h))}h` : `${Math.round(h / 24)}d`;
  if (ms < 0) return { text: `Overdue ${span}`, overdue: true, soon: false };
  if (h < 24) return { text: `Due in ${span}`, overdue: false, soon: true };
  return { text: `Due ${new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, overdue: false, soon: false };
}

export const refundedTotal = (o: Order) => o.refunds.filter((r) => r.status !== "FAILED").reduce((s, r) => s + r.amount, 0);
