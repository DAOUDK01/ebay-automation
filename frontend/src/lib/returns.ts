/** Returns, cancellations and cases (backend module: src/modules/returns). */

export type PostOrderKind = "return" | "cancellation" | "case";

export interface Amount {
  value: number;
  currency: string;
}

export interface CaseEvent {
  at: string | null;
  actor: string;
  action: string;
  text: string;
}

export interface PostOrderCase {
  _id: string;
  kind: PostOrderKind;
  ebayId: string;
  type: string;
  state: string;
  status: string;
  open: boolean;
  buyer: string;
  itemId: string;
  itemTitle: string;
  orderId: string;
  transactionId: string;
  quantity: number;
  reason: string;
  comments: string;
  amount: Amount | null;
  refunded: Amount | null;
  respondBy: string | null;
  dueAction: string;
  openedAt: string | null;
  ebayUpdatedAt: string | null;
  closedAt: string | null;
  timeline?: CaseEvent[];
  appActions?: CaseEvent[];
  raw?: unknown;
  detailRaw?: unknown;
}

export interface ReturnsInboxResponse {
  items: PostOrderCase[];
  total: number;
  page: number;
  pageSize: number;
  summary: { open: Record<PostOrderKind, number>; dueSoon: number; overdue: number };
}

export interface ReturnDetailResponse {
  item: PostOrderCase;
  related: Pick<PostOrderCase, "_id" | "kind" | "ebayId" | "status" | "open" | "openedAt">[];
  actions: string[];
}

export const KIND_LABEL: Record<PostOrderKind, string> = { return: "Return", cancellation: "Cancellation", case: "Case" };

/** "RETURN_REQUESTED" -> "Return requested" */
export const humanize = (code?: string | null) =>
  code ? code.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "";

export const DUE_ACTION_LABEL: Record<string, string> = {
  SELLER_APPROVE_REQUEST: "Approve or decline the return",
  SELLER_APPROVE_OR_REJECT: "Approve or reject the cancellation",
  SELLER_RESPOND: "Respond to the case",
  SELLER_ISSUE_REFUND: "Issue the refund",
  SELLER_MARK_AS_RECEIVED: "Confirm you received the item",
  SELLER_PROVIDE_RMA: "Provide a return authorization",
};

export type Urgency = "overdue" | "today" | "soon" | "later" | "none";

/** How urgent an eBay deadline is: overdue, < 24h, < 48h, later. */
export function urgency(respondBy: string | null | undefined, now = Date.now()): Urgency {
  if (!respondBy) return "none";
  const h = (new Date(respondBy).getTime() - now) / 3600_000;
  if (h < 0) return "overdue";
  if (h < 24) return "today";
  if (h < 48) return "soon";
  return "later";
}

/** "2d 4h left" / "5h overdue" */
export function timeLeft(respondBy: string, now = Date.now()) {
  const ms = new Date(respondBy).getTime() - now;
  const a = Math.abs(ms);
  const d = Math.floor(a / 86_400_000);
  const h = Math.floor((a % 86_400_000) / 3_600_000);
  const m = Math.max(1, Math.floor((a % 3_600_000) / 60_000));
  const str = d ? `${d}d ${h}h` : h ? `${h}h` : `${m}m`;
  return ms < 0 ? `${str} overdue` : `${str} left`;
}

export const ACTION_LABEL: Record<string, string> = {
  approve: "Approve",
  decline: "Decline",
  reject: "Reject",
  refund: "Refund",
  mark_received: "Mark received",
  message: "Message buyer",
  tracking: "Add tracking",
};
