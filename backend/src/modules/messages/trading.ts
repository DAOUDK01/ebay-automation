/**
 * Trading API calls for messages, kept in this module (uses the shared TradingClient.call).
 * Mapping and request bodies are pure functions so tests can check them without eBay.
 */
import { htmlToText, xmlEscape, type TradingClient } from "../../lib/ebay/trading";
import { threadKeyOf } from "./model";

type Caller = Pick<TradingClient, "call">;

const s = (v: any): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
};
const arr = <T = any>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);
const date = (v: any) => {
  const d = s(v) ? new Date(s(v)) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const bool = (v: any) => s(v).toLowerCase() === "true";

/** What a sync writes for one message (unset fields are left alone on update). */
export interface MappedMessage {
  key: string;
  messageId?: string;
  externalId?: string;
  source: "my_messages" | "member_messages";
  threadKey: string;
  direction: "in" | "out";
  sender: string;
  recipient: string;
  buyer: string;
  itemId: string;
  itemTitle?: string;
  subject?: string;
  body?: string;
  bodyFetched?: boolean;
  messageType: string;
  questionType?: string;
  read?: boolean;
  replied?: boolean;
  flagged?: boolean;
  responseEnabled?: boolean;
  receivedAt: Date | null;
  expiresAt?: Date | null;
}

/** eBay's own notifications (sender "eBay") are not buyer conversations. */
export const isSystemSender = (sender: string) => /^ebay$/i.test(sender.trim()) || sender.trim() === "";

/** GetMyMessages <Message> (headers) -> row. FolderID 1 = Sent. */
export function mapMyMessage(m: any, sellerId: string): MappedMessage {
  const sender = s(m.Sender);
  const recipient = s(m.RecipientUserID) || s(m.SendToName);
  const out = s(m.Folder?.FolderID) === "1" || sender.toLowerCase() === sellerId.toLowerCase();
  const buyer = out ? recipient : sender;
  const itemId = s(m.ItemID);
  const messageId = s(m.MessageID);
  const externalId = s(m.ExternalMessageID);
  return {
    key: externalId || messageId,
    messageId,
    externalId,
    source: "my_messages",
    threadKey: threadKeyOf(buyer, itemId),
    direction: out ? "out" : "in",
    sender,
    recipient,
    buyer,
    itemId,
    itemTitle: s(m.ItemTitle),
    subject: s(m.Subject),
    messageType: s(m.MessageType),
    questionType: s(m.QuestionType),
    read: out || bool(m.Read),
    replied: bool(m.Replied),
    flagged: bool(m.Flagged),
    responseEnabled: bool(m.ResponseDetails?.ResponseEnabled),
    receivedAt: date(m.ReceiveDate),
    expiresAt: date(m.ExpirationDate),
  };
}

/** GetMyMessages ReturnMessages <Message> -> plain-text body (Content is plain text; Text is eBay's HTML email). */
export function messageBody(m: any): string {
  const content = s(m.Content).trim();
  if (content) return content.slice(0, 8000);
  return htmlToText(s(m.Text), 8000);
}

/** GetMemberMessages <MemberMessageExchange> -> the question (+ our earlier answers). */
export function mapMemberExchange(ex: any, sellerId: string): MappedMessage[] {
  const q = ex.Question ?? {};
  const qid = s(q.MessageID);
  if (!qid) return [];
  const buyer = s(q.SenderID);
  const itemId = s(ex.Item?.ItemID);
  const threadKey = threadKeyOf(buyer, itemId);
  const answered = s(ex.MessageStatus) === "Answered";
  const question: MappedMessage = {
    key: qid,
    externalId: qid,
    source: "member_messages",
    threadKey,
    direction: "in",
    sender: buyer,
    recipient: s(q.RecipientID) || sellerId,
    buyer,
    itemId,
    itemTitle: s(ex.Item?.Title),
    subject: s(q.Subject),
    body: s(q.Body).slice(0, 8000),
    bodyFetched: true,
    messageType: s(q.MessageType) || "AskSellerQuestion",
    questionType: s(q.QuestionType),
    replied: answered,
    responseEnabled: true,
    receivedAt: date(ex.CreationDate),
  };
  const answers = arr(ex.Response).map(
    (r, i): MappedMessage => ({
      key: `${qid}:r${i}`,
      source: "member_messages",
      threadKey,
      direction: "out",
      sender: sellerId,
      recipient: buyer,
      buyer,
      itemId,
      itemTitle: s(ex.Item?.Title),
      subject: `Re: ${s(q.Subject)}`,
      body: s(r).slice(0, 8000),
      bodyFetched: true,
      messageType: "ResponseToASQQuestion",
      read: true,
      receivedAt: date(ex.LastModifiedDate) ?? date(ex.CreationDate),
    }),
  );
  return [question, ...answers];
}

// ---------------------------------------------------------------------------------------------
// Request bodies

const page = (n: number, per: number) => `<Pagination><EntriesPerPage>${per}</EntriesPerPage><PageNumber>${n}</PageNumber></Pagination>`;

export const buildHeadersXml = (folderId: number, from: Date, to: Date, pageNumber: number, perPage = 100) =>
  `<DetailLevel>ReturnHeaders</DetailLevel><FolderID>${folderId}</FolderID>` +
  `<StartTime>${from.toISOString()}</StartTime><EndTime>${to.toISOString()}</EndTime>${page(pageNumber, perPage)}`;

export const buildBodiesXml = (messageIds: string[]) =>
  `<DetailLevel>ReturnMessages</DetailLevel><MessageIDs>${messageIds.map((id) => `<MessageID>${xmlEscape(id)}</MessageID>`).join("")}</MessageIDs>`;

export const buildMemberMessagesXml = (from: Date, to: Date, pageNumber: number, perPage = 100) =>
  `<MailMessageType>AskSellerQuestion</MailMessageType>` +
  `<StartCreationTime>${from.toISOString()}</StartCreationTime><EndCreationTime>${to.toISOString()}</EndCreationTime>${page(pageNumber, perPage)}`;

export const buildMarkReadXml = (messageIds: string[], read = true) =>
  `<MessageIDs>${messageIds.map((id) => `<MessageID>${xmlEscape(id)}</MessageID>`).join("")}</MessageIDs><Read>${read}</Read>`;

/** Answer a buyer's question (AddMemberMessageRTQ). */
export const buildRtqXml = (o: { itemId: string; parentId: string; buyer: string; body: string }) =>
  (o.itemId ? `<ItemID>${xmlEscape(o.itemId)}</ItemID>` : "") +
  `<MemberMessage><Body>${xmlEscape(o.body)}</Body><DisplayToPublic>false</DisplayToPublic><EmailCopyToSender>true</EmailCopyToSender>` +
  `<ParentMessageID>${xmlEscape(o.parentId)}</ParentMessageID><RecipientID>${xmlEscape(o.buyer)}</RecipientID></MemberMessage>`;

/** Message an order buyer (AddMemberMessageAAQToPartner). */
export const buildPartnerXml = (o: { itemId: string; buyer: string; subject: string; body: string }) =>
  `<ItemID>${xmlEscape(o.itemId)}</ItemID><MemberMessage><Body>${xmlEscape(o.body)}</Body><EmailCopyToSender>true</EmailCopyToSender>` +
  `<QuestionType>General</QuestionType><RecipientID>${xmlEscape(o.buyer)}</RecipientID>` +
  `<Subject>${xmlEscape(o.subject.slice(0, 100))}</Subject></MemberMessage>`;

// ---------------------------------------------------------------------------------------------
// Calls

export async function fetchHeaders(t: Caller, sellerId: string, from: Date, to: Date, maxPages = 10): Promise<MappedMessage[]> {
  const out: MappedMessage[] = [];
  for (const folder of [0, 1]) {
    for (let p = 1; p <= maxPages; p++) {
      const root = await t.call("GetMyMessages", buildHeadersXml(folder, from, to, p));
      const rows = arr(root.Messages?.Message);
      out.push(...rows.map((m) => mapMyMessage(m, sellerId)));
      const pages = Number(s(root.PaginationResult?.TotalNumberOfPages)) || 1;
      if (!rows.length || p >= pages) break;
    }
  }
  return out;
}

/** messageId -> plain-text body (10 ids per call, eBay's limit). */
export async function fetchBodies(t: Caller, messageIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < messageIds.length; i += 10) {
    const root = await t.call("GetMyMessages", buildBodiesXml(messageIds.slice(i, i + 10)));
    for (const m of arr(root.Messages?.Message)) out.set(s(m.MessageID), messageBody(m));
  }
  return out;
}

export async function fetchQuestions(t: Caller, sellerId: string, from: Date, to: Date, maxPages = 10): Promise<MappedMessage[]> {
  const out: MappedMessage[] = [];
  for (let p = 1; p <= maxPages; p++) {
    const root = await t.call("GetMemberMessages", buildMemberMessagesXml(from, to, p));
    const rows = arr(root.MemberMessage?.MemberMessageExchange);
    for (const ex of rows) out.push(...mapMemberExchange(ex, sellerId));
    const pages = Number(s(root.PaginationResult?.TotalNumberOfPages)) || 1;
    if (!rows.length || p >= pages) break;
  }
  return out;
}
