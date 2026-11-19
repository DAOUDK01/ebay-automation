/** Buyer messages (backend module: src/modules/messages). */

export interface MessageThread {
  id: string;
  buyer: string;
  itemId: string;
  itemTitle: string;
  subject: string;
  preview: string;
  lastDirection: "in" | "out";
  lastAt: string | null;
  count: number;
  unread: number;
  needsReply: boolean;
}

export interface ThreadsResponse {
  items: MessageThread[];
  total: number;
  page: number;
  pageSize: number;
  unreadThreads: number;
}

export interface BuyerMessage {
  _id: string;
  key: string;
  source: "my_messages" | "member_messages" | "app";
  direction: "in" | "out";
  sender: string;
  recipient: string;
  buyer: string;
  itemId: string;
  itemTitle: string;
  subject: string;
  body: string;
  bodyFetched: boolean;
  messageType: string;
  read: boolean;
  replied: boolean;
  receivedAt: string | null;
}

export interface ThreadDetailResponse {
  thread: { id: string; buyer: string; itemId: string; itemTitle: string; subject: string; unread: number; reply: "rtq" | "partner" };
  messages: BuyerMessage[];
  listing: { itemId: string; title: string; price?: number; imageUrl?: string; sku?: string } | null;
  cases: { _id: string; kind: string; ebayId: string; status: string; open: boolean; respondBy: string | null }[];
}

export interface ReplyTemplate {
  _id: string;
  name: string;
  body: string;
}

export const MAX_MESSAGE = 2000;

/** Fill {buyer} and {item} in a template. */
export const fillTemplate = (body: string, vars: { buyer: string; item: string }) =>
  body.replace(/\{buyer\}/gi, vars.buyer).replace(/\{item\}/gi, vars.item);

export const ebayItemUrl = (itemId: string) => `https://www.ebay.com/itm/${encodeURIComponent(itemId)}`;
