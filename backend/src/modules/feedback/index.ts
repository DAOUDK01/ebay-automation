/**
 * Feedback: Trading GetFeedback / GetItemsAwaitingFeedback / GetUser (sync), RespondToFeedback / LeaveFeedback (user clicks),
 * plus opt-in auto-positive feedback for buyers (FeedbackSettings.autoPositive, off by default).
 */
import type { AccountModule } from "../types";
import { feedbackRouter } from "./routes";
import { feedbackCounts, syncFeedback } from "./service";

const feedback: AccountModule = {
  key: "feedback",
  label: "Feedback",
  ready: true,
  scopes: [],
  router: feedbackRouter(),
  sync: syncFeedback,
  counts: feedbackCounts,
};

export default feedback;
