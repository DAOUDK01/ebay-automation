/** Types for the Feedback module (backend src/modules/feedback). */

export type FeedbackRating = "Positive" | "Neutral" | "Negative" | "Withdrawn";

export interface FeedbackEntry {
  _id: string;
  feedbackId: string;
  direction: "received" | "left";
  role: string;
  rating: FeedbackRating;
  comment: string;
  /** the other party (buyer); "" when eBay didn't say */
  user: string;
  userScore: number | null;
  itemId: string;
  itemTitle: string;
  itemPrice: number | null;
  currency: string;
  transactionId: string;
  date: string;
  response: string;
  respondedAt: string | null;
  followUp: string;
}

export interface AwaitingFeedback {
  _id: string;
  itemId: string;
  transactionId: string;
  orderLineItemId: string;
  buyer: string;
  title: string;
  imageUrl: string;
  endTime: string | null;
}

export interface PeriodCount {
  positive: number;
  neutral: number;
  negative: number;
  /** "ebay" = eBay's own numbers, "synced" = counted from the feedback synced into this app */
  source: "ebay" | "synced";
}

export interface FeedbackSettings {
  autoPositive: boolean;
  autoText: string;
}

export interface FeedbackSummary {
  periods: Record<"30" | "90" | "365", PeriodCount>;
  score: number | null;
  positivePercent: number | null;
  star: string;
  profileUpdatedAt: string | null;
  needsReply: number;
  awaiting: number;
  settings: FeedbackSettings;
}

export interface LeaveResult {
  id: string;
  buyer: string;
  itemId: string;
  ok: boolean;
  error?: string;
}

/** eBay limits replies and feedback comments to 80 characters. */
export const FEEDBACK_MAX = 80;
export const DEFAULT_LEAVE_TEXT = "Great buyer, smooth transaction. Thank you!";

export const FEEDBACK_FILTERS = [
  { key: "", label: "All" },
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
] as const;

export const ratingColor = (r: FeedbackRating) =>
  r === "Positive" ? "green" : r === "Negative" ? "red" : r === "Neutral" ? "yellow" : "gray";
