/**
 * Post-Order API v2: mapping eBay's JSON to our PostOrderCase rows (pure functions, tested) and the
 * request payloads for seller actions (also pure, so tests check exactly what would be sent).
 * Search pages are 1-based: `offset` = page number, `limit` = page size.
 */
import type { PostOrderClient } from "../../lib/ebay/sell";
import type { PostOrderKind } from "./model";

export interface Amount {
  value: number;
  currency: string;
}
export interface TimelineEvent {
  at: Date | null;
  actor: string;
  action: string;
  text: string;
}
/** Fields we keep for a row (everything but storeId / app actions). */
export interface MappedCase {
  kind: PostOrderKind;
  ebayId: string;
  type: string;
  state: string;
  status: string;
  open: boolean;
  buyer: string;
  itemId: string;
  orderId: string;
  transactionId: string;
  quantity: number;
  reason: string;
  comments: string;
  amount: Amount | null;
  refunded: Amount | null;
  respondBy: Date | null;
  dueAction: string;
  openedAt: Date | null;
  ebayUpdatedAt: Date | null;
  closedAt: Date | null;
  raw: unknown;
}

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
/** eBay dates come as { value: "2026-11-01T10:00:00.000Z" } or plain strings. */
export const dateOf = (v: any): Date | null => {
  const raw = v && typeof v === "object" ? v.value ?? v.formattedValue : v;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};
export const amountOf = (v: any): Amount | null => {
  if (!v || v.value === undefined || v.value === null || v.value === "") return null;
  const value = Number(v.value);
  return Number.isFinite(value) ? { value, currency: s(v.currency) || "USD" } : null;
};
const isClosed = (...xs: string[]) => xs.some((x) => /CLOSED/i.test(x));
/** "RETURN_REQUESTED" -> "Return requested" */
export const humanize = (code: string) =>
  code ? code.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "";

export function mapReturn(r: any): MappedCase {
  const ci = r.creationInfo ?? {};
  const state = s(r.state);
  const status = s(r.status);
  const open = !isClosed(state, status);
  const due = r.sellerResponseDue ?? {};
  const refund = r.sellerTotalRefund ?? r.buyerTotalRefund ?? {};
  return {
    kind: "return",
    ebayId: s(r.returnId),
    type: s(r.currentType || ci.type),
    state,
    status,
    open,
    buyer: s(r.buyerLoginName),
    itemId: s(ci.item?.itemId),
    transactionId: s(ci.item?.transactionId),
    orderId: s(r.orderId) || (ci.item?.itemId && ci.item?.transactionId ? `${ci.item.itemId}-${ci.item.transactionId}` : ""),
    quantity: Number(ci.item?.returnQuantity) || 1,
    reason: s(ci.reason),
    comments: s(ci.comments?.content),
    amount: amountOf(refund.estimatedRefundAmount),
    refunded: amountOf(refund.actualRefundAmount),
    respondBy: open ? dateOf(due.respondByDate) : null,
    dueAction: open ? s(due.activityDue) : "",
    openedAt: dateOf(ci.creationDate),
    ebayUpdatedAt: dateOf(r.lastModifiedDate) ?? dateOf(ci.creationDate),
    closedAt: open ? null : dateOf(r.closeInfo?.returnCloseDate) ?? dateOf(r.lastModifiedDate),
    raw: r,
  };
}

export function mapCancellation(c: any): MappedCase {
  const state = s(c.cancelState);
  const status = s(c.cancelStatus);
  const open = !isClosed(state, status);
  const [itemId, transactionId] = s(c.legacyOrderId).split("-");
  const awaitingSeller = open && /REQUESTED|PENDING/i.test(status);
  return {
    kind: "cancellation",
    ebayId: s(c.cancelId),
    type: s(c.requestorType) || "BUYER",
    state,
    status,
    open,
    buyer: s(c.buyerLoginName),
    itemId: s(c.itemId) || itemId || "",
    transactionId: s(c.transactionId) || transactionId || "",
    orderId: s(c.legacyOrderId),
    quantity: 1,
    reason: s(c.cancelReason),
    comments: s(c.buyerComments ?? c.cancelComments),
    amount: amountOf(c.requestRefundAmount),
    refunded: amountOf(c.refundAmount ?? c.actualRefundAmount),
    respondBy: awaitingSeller ? dateOf(c.sellerResponseDueDate) : null,
    dueAction: awaitingSeller ? "SELLER_APPROVE_OR_REJECT" : "",
    openedAt: dateOf(c.cancelRequestDate),
    ebayUpdatedAt: dateOf(c.lastModifiedDate) ?? dateOf(c.cancelCloseDate) ?? dateOf(c.cancelRequestDate),
    closedAt: open ? null : dateOf(c.cancelCloseDate),
    raw: c,
  };
}

export function mapCase(c: any): MappedCase {
  const status = s(c.caseStatusEnum ?? c.status);
  const open = !isClosed(status);
  return {
    kind: "case",
    ebayId: s(c.caseId),
    type: s(c.caseType),
    state: open ? "OPEN" : "CLOSED",
    status,
    open,
    buyer: s(c.buyer ?? c.buyerLoginName),
    itemId: s(c.itemId),
    transactionId: s(c.transactionId),
    orderId: c.itemId && c.transactionId ? `${c.itemId}-${c.transactionId}` : "",
    quantity: 1,
    reason: s(c.caseType),
    comments: "",
    amount: amountOf(c.claimAmount),
    refunded: null,
    respondBy: open ? dateOf(c.respondByDate) : null,
    dueAction: open && c.respondByDate ? "SELLER_RESPOND" : "",
    openedAt: dateOf(c.creationDate),
    ebayUpdatedAt: dateOf(c.lastModifiedDate) ?? dateOf(c.creationDate),
    closedAt: open ? null : dateOf(c.lastModifiedDate),
    raw: c,
  };
}

/** History from a detail call -> timeline events (oldest first). */
export function mapTimeline(kind: PostOrderKind, detail: any): TimelineEvent[] {
  const rows: any[] =
    kind === "return"
      ? detail?.detail?.responseHistory ?? []
      : kind === "cancellation"
        ? detail?.cancelDetail?.activityHistories ?? detail?.activityHistories ?? []
        : detail?.caseHistoryDetails?.history ?? detail?.history ?? [];
  return rows
    .map((h) => ({
      at: dateOf(h.creationDate ?? h.date ?? h.actionDate),
      actor: s(h.author ?? h.actorType ?? h.actor ?? "SYSTEM").toUpperCase(),
      action: s(h.activity ?? h.activityType ?? h.action),
      text: s(h.notes ?? h.description ?? (h.toState ? `→ ${humanize(s(h.toState))}` : "")),
    }))
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
}

// ---------------------------------------------------------------------------------------------
// Searches

export const SEARCH = {
  return: { path: "/post-order/v2/return/search", key: "members", from: "creation_date_range_from", extra: { role: "SELLER" } },
  cancellation: { path: "/post-order/v2/cancellation/search", key: "cancellations", from: "creation_date_range_from", extra: {} },
  case: { path: "/post-order/v2/casemanagement/search", key: "members", from: "case_creation_date_range_from", extra: {} },
} as const;

export const MAPPERS: Record<PostOrderKind, (raw: any) => MappedCase> = { return: mapReturn, cancellation: mapCancellation, case: mapCase };

/** Every row of one search created since `from` (pages until done; at most `maxPages`). */
export async function searchAll(client: Pick<PostOrderClient, "get">, kind: PostOrderKind, from: Date, pageSize = 50, maxPages = 20): Promise<any[]> {
  const cfg = SEARCH[kind];
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res: any = await client.get(cfg.path, { ...cfg.extra, [cfg.from]: from.toISOString(), limit: pageSize, offset: page });
    const rows: any[] = res?.[cfg.key] ?? [];
    out.push(...rows);
    const pages = Number(res?.paginationOutput?.totalPages ?? 0);
    if (!rows.length || rows.length < pageSize || (pages && page >= pages)) break;
  }
  return out;
}

export const DETAIL_PATH: Record<PostOrderKind, (id: string) => string> = {
  return: (id) => `/post-order/v2/return/${encodeURIComponent(id)}?fieldgroups=FULL`,
  cancellation: (id) => `/post-order/v2/cancellation/${encodeURIComponent(id)}`,
  case: (id) => `/post-order/v2/casemanagement/${encodeURIComponent(id)}`,
};

/** A detail response -> the summary object the mappers understand. */
export function summaryFromDetail(kind: PostOrderKind, detail: any): any {
  if (kind === "return") return detail?.summary ?? detail;
  if (kind === "cancellation") return detail?.cancelDetail ?? detail;
  return detail;
}

// ---------------------------------------------------------------------------------------------
// Seller actions. Each returns the exact request to send; the router sends it after the user confirms.

export interface PostOrderRequest {
  path: string;
  body: Record<string, unknown>;
  /** shown in the case timeline */
  label: string;
}

const rid = (id: string) => encodeURIComponent(id);
const comments = (text?: string) => (text?.trim() ? { comments: { content: text.trim() } } : {});

export const actions = {
  approveReturn: (id: string, note?: string): PostOrderRequest => ({
    path: `/post-order/v2/return/${rid(id)}/decide`,
    body: { decision: "ACCEPT", ...comments(note) },
    label: "Approved the return",
  }),
  declineReturn: (id: string, note: string): PostOrderRequest => ({
    path: `/post-order/v2/return/${rid(id)}/decide`,
    body: { decision: "DECLINE", ...comments(note) },
    label: "Declined the return",
  }),
  refundReturn: (id: string, amount: Amount, note?: string): PostOrderRequest => {
    const money = { value: Math.round(amount.value * 100) / 100, currency: amount.currency };
    return {
      path: `/post-order/v2/return/${rid(id)}/issue_refund`,
      body: {
        refundDetail: { itemizedRefundDetail: [{ refundAmount: money, refundFeeType: "PURCHASE_PRICE" }], totalAmount: money },
        ...comments(note),
      },
      label: `Issued a refund of ${money.currency} ${money.value.toFixed(2)}`,
    };
  },
  markReturnReceived: (id: string, note?: string): PostOrderRequest => ({
    path: `/post-order/v2/return/${rid(id)}/mark_as_received`,
    body: { ...comments(note) },
    label: "Marked the item as received",
  }),
  messageReturn: (id: string, text: string): PostOrderRequest => ({
    path: `/post-order/v2/return/${rid(id)}/send_message`,
    body: { message: { content: text.trim() } },
    label: `Message: ${text.trim()}`,
  }),
  approveCancellation: (id: string): PostOrderRequest => ({
    path: `/post-order/v2/cancellation/${rid(id)}/approve`,
    body: {},
    label: "Approved the cancellation",
  }),
  rejectCancellation: (id: string, shipped?: { trackingNumber?: string; shippedDate?: string }): PostOrderRequest => ({
    path: `/post-order/v2/cancellation/${rid(id)}/reject`,
    body: {
      ...(shipped?.trackingNumber ? { trackingNumber: shipped.trackingNumber.trim() } : {}),
      ...(shipped?.shippedDate ? { shipmentDate: { value: new Date(shipped.shippedDate).toISOString() } } : {}),
    },
    label: `Rejected the cancellation${shipped?.trackingNumber ? ` (shipped, tracking ${shipped.trackingNumber.trim()})` : ""}`,
  }),
  caseShipment: (id: string, carrier: string, trackingNumber: string, shippedDate?: string): PostOrderRequest => ({
    path: `/post-order/v2/casemanagement/${rid(id)}/provide_shipment_info`,
    body: {
      shippingCarrierName: carrier.trim(),
      trackingNumber: trackingNumber.trim(),
      ...(shippedDate ? { shipmentDate: { value: new Date(shippedDate).toISOString() } } : {}),
    },
    label: `Sent tracking ${carrier.trim()} ${trackingNumber.trim()}`,
  }),
  caseRefund: (id: string, note?: string): PostOrderRequest => ({
    path: `/post-order/v2/casemanagement/${rid(id)}/issue_refund`,
    body: { ...comments(note) },
    label: "Issued a full refund",
  }),
};
