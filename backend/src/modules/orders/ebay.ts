/**
 * Pure helpers for the Fulfillment API: turn an eBay order into our Order shape, build the tracking and
 * refund request bodies, and parse a bulk-tracking CSV. No I/O here, so it's all unit-testable.
 */
import type { OrderStatus } from "./model";

export const FULFILLMENT = "/sell/fulfillment/v1";

const num = (m: any) => {
  const n = Number(m?.value ?? m ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const date = (s: any) => (s ? new Date(s) : null);
const str = (s: any) => (s === undefined || s === null ? "" : String(s));

/** Our status from eBay's states. Cancelled wins, then shipped, then refunded, then paid / unpaid. */
export function deriveStatus(o: any): OrderStatus {
  const cancel = str(o?.cancelStatus?.cancelState);
  const pay = str(o?.orderPaymentStatus);
  const ful = str(o?.orderFulfillmentStatus);
  if (cancel === "CANCELED") return "cancelled";
  if (ful === "FULFILLED") return "shipped";
  if (pay === "FULLY_REFUNDED") return "refunded";
  if (pay === "PAID" || pay === "PARTIALLY_REFUNDED") return "awaiting_shipment";
  return "awaiting_payment";
}

export interface EbayFulfillment {
  fulfillmentId?: string;
  shipmentTrackingNumber?: string;
  shippingCarrierCode?: string;
  shippedDate?: string;
  lineItems?: { lineItemId: string; quantity?: number }[];
}

export function normalizeFulfillment(f: EbayFulfillment) {
  return {
    fulfillmentId: str(f.fulfillmentId),
    carrier: str(f.shippingCarrierCode),
    trackingNumber: str(f.shipmentTrackingNumber),
    shippedDate: date(f.shippedDate),
    lineItems: (f.lineItems ?? []).map((l) => ({ lineItemId: str(l.lineItemId), qty: Number(l.quantity ?? 1) })),
  };
}

/** eBay order JSON -> fields of our Order model (images come from our Listing collection, see sync.ts). */
export function normalizeOrder(o: any, images: Record<string, string> = {}, fulfillments?: EbayFulfillment[]) {
  const step = o?.fulfillmentStartInstructions?.[0]?.shippingStep ?? {};
  const to = step.shipTo ?? {};
  const addr = to.contactAddress ?? {};
  const ps = o?.pricingSummary ?? {};
  const currency = str(ps.total?.currency || o?.lineItems?.[0]?.total?.currency || "USD");
  const shipBy = (o?.lineItems ?? [])
    .map((l: any) => l?.lineItemFulfillmentInstructions?.shipByDate)
    .filter(Boolean)
    .sort()[0];
  const fee = o?.totalMarketplaceFee;
  return {
    orderId: str(o.orderId),
    legacyOrderId: str(o.legacyOrderId),
    status: deriveStatus(o),
    paymentStatus: str(o.orderPaymentStatus),
    fulfillmentStatus: str(o.orderFulfillmentStatus),
    cancelState: str(o?.cancelStatus?.cancelState),
    buyer: {
      username: str(o?.buyer?.username),
      name: str(o?.buyer?.buyerRegistrationAddress?.fullName || to.fullName),
      email: str(to.email || o?.buyer?.buyerRegistrationAddress?.email),
    },
    shipTo: {
      name: str(to.fullName),
      line1: str(addr.addressLine1),
      line2: str(addr.addressLine2),
      city: str(addr.city),
      state: str(addr.stateOrProvince),
      postalCode: str(addr.postalCode),
      country: str(addr.countryCode),
      phone: str(to.primaryPhone?.phoneNumber),
    },
    lineItems: (o?.lineItems ?? []).map((l: any) => ({
      lineItemId: str(l.lineItemId),
      itemId: str(l.legacyItemId),
      title: str(l.title),
      sku: str(l.sku),
      qty: Number(l.quantity ?? 1),
      price: num(l.lineItemCost) / Math.max(1, Number(l.quantity ?? 1)),
      total: num(l.total ?? l.lineItemCost),
      image: images[str(l.legacyItemId)] ?? "",
      fulfillmentStatus: str(l.lineItemFulfillmentStatus),
    })),
    totals: {
      subtotal: num(ps.priceSubtotal),
      shipping: num(ps.deliveryCost) - num(ps.deliveryDiscount),
      tax: num(ps.tax) + num(o?.lineItems?.reduce?.((s: number, l: any) => s + num(l?.ebayCollectAndRemitTaxes?.[0]?.amount), 0)),
      discount: Math.abs(num(ps.priceDiscount)),
      total: num(ps.total),
      currency,
    },
    fees: fee ? num(fee) : null,
    shippingService: str(step.shippingServiceCode),
    shipByDate: date(shipBy),
    buyerNotes: str(o.buyerCheckoutNotes),
    ...(fulfillments ? { fulfillments: fulfillments.map(normalizeFulfillment) } : {}),
    refunds: (o?.paymentSummary?.refunds ?? []).map((r: any) => ({
      refundId: str(r.refundId),
      amount: num(r.amount),
      currency: str(r.amount?.currency || currency),
      date: date(r.refundDate),
      status: str(r.refundStatus),
      reason: "",
    })),
    creationDate: date(o.creationDate) ?? new Date(),
    lastModifiedDate: date(o.lastModifiedDate) ?? new Date(),
    raw: o,
  };
}

// ---------------------------------------------------------------- tracking

/** Common ways people write carriers -> eBay's shippingCarrierCode. Unknown names are passed through. */
const CARRIERS: Record<string, string> = {
  usps: "USPS",
  "us postal service": "USPS",
  ups: "UPS",
  fedex: "FedEx",
  "fed ex": "FedEx",
  dhl: "DHL",
  "dhl express": "DHL",
  ontrac: "OnTrac",
  lasership: "LaserShip",
  canadapost: "CanadaPost",
  "canada post": "CanadaPost",
  royalmail: "RoyalMail",
  "royal mail": "RoyalMail",
  purolator: "Purolator",
  "australia post": "AustraliaPost",
};
export const CARRIER_OPTIONS = ["USPS", "UPS", "FedEx", "DHL", "OnTrac", "LaserShip", "CanadaPost", "RoyalMail", "Purolator", "AustraliaPost"];

export function carrierCode(name: string): string {
  const k = name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return CARRIERS[k] ?? CARRIERS[k.replace(/\s/g, "")] ?? name.trim();
}

export interface TrackingInput {
  carrier: string;
  trackingNumber: string;
  shippedDate?: Date | string;
  /** default: every line item not shipped yet, full quantity */
  lineItems?: { lineItemId: string; quantity: number }[];
}

/** Body for POST /order/{orderId}/shipping_fulfillment. */
export function buildTrackingPayload(order: { lineItems: { lineItemId: string; qty: number; fulfillmentStatus?: string }[] }, t: TrackingInput) {
  const tracking = t.trackingNumber.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{6,40}$/.test(tracking)) throw new Error("Tracking number should be 6-40 letters or digits");
  const carrier = carrierCode(t.carrier);
  if (!carrier) throw new Error("Carrier is required");
  let lines = t.lineItems?.length
    ? t.lineItems
    : order.lineItems.filter((l) => l.fulfillmentStatus !== "FULFILLED").map((l) => ({ lineItemId: l.lineItemId, quantity: l.qty }));
  if (!lines.length) lines = order.lineItems.map((l) => ({ lineItemId: l.lineItemId, quantity: l.qty }));
  const known = new Set(order.lineItems.map((l) => l.lineItemId));
  for (const l of lines) if (!known.has(l.lineItemId)) throw new Error(`Line item ${l.lineItemId} is not in this order`);
  const shipped = t.shippedDate ? new Date(t.shippedDate) : new Date();
  if (Number.isNaN(shipped.getTime())) throw new Error("Invalid shipped date");
  return {
    lineItems: lines.map((l) => ({ lineItemId: l.lineItemId, quantity: l.quantity })),
    shippedDate: shipped.toISOString(),
    shippingCarrierCode: carrier,
    trackingNumber: tracking,
  };
}

// ---------------------------------------------------------------- refunds

export const REFUND_REASONS = [
  "BUYER_CANCEL",
  "BUYER_RETURN",
  "ITEM_NOT_RECEIVED",
  "SELLER_WRONG_ITEM",
  "SELLER_OUT_OF_STOCK",
  "SELLER_FOUND_CHEAPER_PRICE",
  "OTHER",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export interface RefundInput {
  kind: "full" | "partial";
  /** partial refunds only */
  amount?: number;
  reason: RefundReason;
  comment?: string;
}

/** What's left to refund on an order (total minus refunds that didn't fail). */
export function refundable(order: { totals: { total: number }; refunds: { amount: number; status?: string }[] }) {
  const done = order.refunds.filter((r) => r.status !== "FAILED").reduce((s, r) => s + r.amount, 0);
  return Math.max(0, Math.round((order.totals.total - done) * 100) / 100);
}

/** Body for POST /order/{orderId}/issue_refund (order-level amount, full or partial). */
export function buildRefundPayload(
  order: { totals: { total: number; currency: string }; refunds: { amount: number; status?: string }[] },
  r: RefundInput,
) {
  const max = refundable(order);
  if (max <= 0) throw new Error("This order has already been fully refunded");
  const amount = r.kind === "full" ? max : Math.round(Number(r.amount ?? 0) * 100) / 100;
  if (!(amount > 0)) throw new Error("Refund amount must be more than 0");
  if (amount > max + 1e-9) throw new Error(`Refund amount can't be more than ${max.toFixed(2)}`);
  return {
    reasonForRefund: r.reason,
    ...(r.comment?.trim() ? { comment: r.comment.trim().slice(0, 100) } : {}),
    orderLevelRefundAmount: { value: amount.toFixed(2), currency: order.totals.currency || "USD" },
  };
}

// ---------------------------------------------------------------- bulk tracking CSV

export interface CsvTrackingRow {
  line: number;
  orderId: string;
  carrier: string;
  trackingNumber: string;
}

/** Split one CSV line, honouring "quoted, values" and "" escapes. */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse "orderId,carrier,tracking" lines (comma, semicolon or tab separated; a header row is optional and
 * may put the columns in any order). Returns rows plus a message per line that couldn't be read.
 */
export function parseTrackingCsv(text: string): { rows: CsvTrackingRow[]; errors: string[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? "";
  const sep = first.includes("\t") ? "\t" : first.includes(";") && !first.includes(",") ? ";" : ",";
  let cols = { orderId: 0, carrier: 1, trackingNumber: 2 };
  const rows: CsvTrackingRow[] = [];
  const errors: string[] = [];
  let headerDone = false;
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const cells = splitCsvLine(raw, sep);
    if (!headerDone) {
      headerDone = true;
      const h = cells.map((c) => c.toLowerCase().replace(/[^a-z]/g, ""));
      const find = (...names: string[]) => h.findIndex((c) => names.some((n) => c.includes(n)));
      const o = find("order");
      const c = find("carrier", "courier", "shippedvia");
      const t = find("tracking", "trackingnumber");
      if (o >= 0 || t >= 0 || c >= 0) {
        if (o < 0 || c < 0 || t < 0) errors.push("Header row needs order id, carrier and tracking columns");
        else cols = { orderId: o, carrier: c, trackingNumber: t };
        return;
      }
    }
    const orderId = cells[cols.orderId] ?? "";
    const carrier = cells[cols.carrier] ?? "";
    const trackingNumber = (cells[cols.trackingNumber] ?? "").replace(/\s+/g, "");
    if (!orderId || !carrier || !trackingNumber) {
      errors.push(`Line ${i + 1}: needs order id, carrier and tracking number`);
      return;
    }
    rows.push({ line: i + 1, orderId, carrier, trackingNumber });
  });
  return { rows, errors };
}
