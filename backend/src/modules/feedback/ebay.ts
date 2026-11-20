/**
 * Trading API calls for feedback: GetFeedback, GetItemsAwaitingFeedback, GetUser, LeaveFeedback, RespondToFeedback.
 * Uses the shared TradingClient.call (auth, retries, error handling); parsing is done here with pure functions
 * that the tests exercise directly.
 */
import type { TradingClient } from "../../lib/ebay/trading";
import { xmlEscape } from "../../lib/ebay/trading";
import type { Rating } from "./model";

export type Trading = Pick<TradingClient, "call">;

// The shared parser only forces a few tags to arrays; a single <FeedbackDetail> comes back as an object.
export const arr = <T = any>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);
export const txt = (v: any): string => {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
};
const numOrNull = (v: any) => {
  const s = txt(v);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const dateOrNull = (v: any) => {
  const s = txt(v);
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** eBay caps reply and feedback text at 80 characters. */
export const MAX_TEXT = 80;

export type FeedbackKind = "FeedbackReceivedAsSeller" | "FeedbackLeft";

export interface ParsedFeedback {
  feedbackId: string;
  direction: "received" | "left";
  role: string;
  rating: Rating;
  comment: string;
  user: string;
  userScore: number | null;
  itemId: string;
  itemTitle: string;
  itemPrice: number | null;
  currency: string;
  transactionId: string;
  orderLineItemId: string;
  date: Date;
  response: string;
  followUp: string;
}

const RATING: Record<string, Rating> = {
  Positive: "Positive",
  Neutral: "Neutral",
  Negative: "Negative",
  Withdrawn: "Withdrawn",
  IndependentlyWithdrawn: "Withdrawn",
};

/** <FeedbackDetail> -> ParsedFeedback (null when it can't be used). `me` = our eBay user id. */
export function parseFeedbackDetail(d: any, kind: FeedbackKind, me: string): ParsedFeedback | null {
  const feedbackId = txt(d?.FeedbackID);
  const date = dateOrNull(d?.CommentTime);
  const rating = RATING[txt(d?.CommentType)];
  if (!feedbackId || !date || !rating) return null;
  const commenting = txt(d.CommentingUser);
  // FeedbackLeft entries name us as the commenting user; the buyer is only known when eBay says so
  const user = kind === "FeedbackLeft" && commenting.toLowerCase() === me.toLowerCase() ? "" : commenting;
  // FeedbackResponse/FollowUp text: our reply to a buyer's comment and their follow-up
  return {
    feedbackId,
    direction: kind === "FeedbackLeft" ? "left" : "received",
    role: txt(d.Role),
    rating,
    comment: txt(d.CommentText),
    user,
    userScore: kind === "FeedbackLeft" ? null : numOrNull(d.CommentingUserScore),
    itemId: txt(d.ItemID),
    itemTitle: txt(d.ItemTitle),
    itemPrice: numOrNull(d.ItemPrice),
    currency: (d.ItemPrice && typeof d.ItemPrice === "object" && d.ItemPrice["@_currencyID"]) || "USD",
    transactionId: txt(d.TransactionID),
    orderLineItemId: txt(d.OrderLineItemID),
    date,
    response: txt(d.FeedbackResponse),
    followUp: txt(d.FollowUp),
  };
}

export const PERIODS = ["30", "90", "365"] as const;
export type Period = (typeof PERIODS)[number];
export type PeriodCounts = Record<Period, { positive: number; neutral: number; negative: number }>;

/** <FeedbackSummary> -> eBay's counts for the periods it sent (usually 30 / 180 / 365 days; we keep 30, 90, 365). */
export function parseFeedbackSummary(s: any): Partial<PeriodCounts> | null {
  if (!s) return null;
  const out: Partial<PeriodCounts> = {};
  const read = (key: string, field: "positive" | "neutral" | "negative") => {
    for (const p of arr(s[key]?.FeedbackPeriod)) {
      const days = txt(p.PeriodInDays) as Period;
      if (!PERIODS.includes(days)) continue;
      out[days] ??= { positive: 0, neutral: 0, negative: 0 };
      out[days][field] = Number(txt(p.Count)) || 0;
    }
  };
  read("PositiveFeedbackPeriodArray", "positive");
  read("NeutralFeedbackPeriodArray", "neutral");
  read("NegativeFeedbackPeriodArray", "negative");
  return Object.keys(out).length ? out : null;
}

const PAGE_SIZE = 200;

/** One page of GetFeedback (newest first). */
export async function getFeedbackPage(t: Trading, kind: FeedbackKind, page: number, me: string) {
  const root = await t.call(
    "GetFeedback",
    `<FeedbackType>${kind}</FeedbackType><DetailLevel>ReturnAll</DetailLevel>` +
      `<Pagination><EntriesPerPage>${PAGE_SIZE}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`,
  );
  const items = arr(root.FeedbackDetailArray?.FeedbackDetail)
    .map((d) => parseFeedbackDetail(d, kind, me))
    .filter((x): x is ParsedFeedback => !!x);
  return {
    items,
    pages: Number(txt(root.PaginationResult?.TotalNumberOfPages)) || 0,
    summary: parseFeedbackSummary(root.FeedbackSummary),
    score: numOrNull(root.FeedbackScore),
  };
}

export interface AwaitingRow {
  itemId: string;
  transactionId: string;
  orderLineItemId: string;
  buyer: string;
  title: string;
  imageUrl: string;
  endTime: Date | null;
}

/** <Transaction> from GetItemsAwaitingFeedback -> a sale we can rate the buyer for (null for purchases we made). */
export function parseAwaiting(t: any): AwaitingRow | null {
  const item = arr(t?.Item)[0] ?? {};
  const buyer = txt(t?.Buyer?.UserID);
  const itemId = txt(item.ItemID);
  if (!buyer || !itemId) return null; // no Buyer = we were the buyer
  return {
    itemId,
    transactionId: txt(t.TransactionID),
    orderLineItemId: txt(t.OrderLineItemID),
    buyer,
    title: txt(item.Title),
    imageUrl: txt(item.PictureDetails?.GalleryURL),
    endTime: dateOrNull(item.ListingDetails?.EndTime),
  };
}

export async function getItemsAwaitingFeedback(t: Trading, maxPages = 10): Promise<AwaitingRow[]> {
  const out: AwaitingRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const root = await t.call(
      "GetItemsAwaitingFeedback",
      `<Sort>EndTimeDescending</Sort><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`,
    );
    const block = root.ItemsAwaitingFeedback ?? {};
    const rows = arr(block.TransactionArray?.Transaction);
    for (const r of rows) {
      const p = parseAwaiting(r);
      if (p) out.push(p);
    }
    const pages = Number(txt(block.PaginationResult?.TotalNumberOfPages)) || 0;
    if (!rows.length || page >= pages) break;
  }
  return out;
}

/** Feedback score, positive % and star from GetUser. */
export async function getFeedbackProfile(t: Trading) {
  const root = await t.call("GetUser", "<DetailLevel>ReturnAll</DetailLevel>");
  const u = root.User ?? {};
  return {
    userId: txt(u.UserID),
    score: numOrNull(u.FeedbackScore),
    positivePercent: numOrNull(u.PositiveFeedbackPercent),
    star: txt(u.FeedbackRatingStar),
  };
}

/** Sellers can only leave Positive feedback for buyers. Returns the new FeedbackID ("" if eBay didn't send one). */
export async function leaveFeedback(
  t: Trading,
  a: { itemId: string; transactionId?: string; orderLineItemId?: string; buyer: string; text: string },
): Promise<string> {
  const ids = a.orderLineItemId
    ? `<OrderLineItemID>${xmlEscape(a.orderLineItemId)}</OrderLineItemID>`
    : `<ItemID>${xmlEscape(a.itemId)}</ItemID>${a.transactionId ? `<TransactionID>${xmlEscape(a.transactionId)}</TransactionID>` : ""}`;
  const root = await t.call(
    "LeaveFeedback",
    `${ids}<CommentText>${xmlEscape(a.text.slice(0, MAX_TEXT))}</CommentText><CommentType>Positive</CommentType>` +
      `<TargetUser>${xmlEscape(a.buyer)}</TargetUser>`,
    1,
  );
  return txt(root.FeedbackID);
}

/** Public reply to feedback a buyer left us. */
export async function respondToFeedback(
  t: Trading,
  a: { feedbackId: string; itemId: string; transactionId?: string; targetUser: string; text: string },
) {
  await t.call(
    "RespondToFeedback",
    `<FeedbackID>${xmlEscape(a.feedbackId)}</FeedbackID><ItemID>${xmlEscape(a.itemId)}</ItemID>` +
      (a.transactionId ? `<TransactionID>${xmlEscape(a.transactionId)}</TransactionID>` : "") +
      `<TargetUserID>${xmlEscape(a.targetUser)}</TargetUserID><ResponseType>Reply</ResponseType>` +
      `<ResponseText>${xmlEscape(a.text.slice(0, MAX_TEXT))}</ResponseText>`,
    1,
  );
}
