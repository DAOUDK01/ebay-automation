/** Types for the Analytics module API (backend src/modules/analytics). */
import type { SyncInfo } from "./finances";

export interface TrafficDayPoint {
  day: string;
  impressions: number;
  views: number;
  transactions: number;
}

export interface StandardsMetric {
  key: string;
  name?: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  level?: string;
  thresholdUpper: number | null;
  thresholdLower: number | null;
}

export interface StandardsProfile {
  program?: string;
  level?: string;
  cycle?: string;
  evaluationDate?: string;
  evaluationReason?: string;
  defaultProgram?: boolean;
  metrics: StandardsMetric[];
}

export interface AccountHealth {
  sellerLevel: string | null;
  profiles: StandardsProfile[];
  customerService: { type: string; dimension: string; rate: number | null; rating?: string }[];
  fetchedAt: string;
}

export interface AnalyticsOverview {
  hasData: boolean;
  days: TrafficDayPoint[];
  totals: { impressions: number; views: number; transactions: number; ctr: number | null; conversion: number | null };
  health: AccountHealth | null;
  thresholds: Record<string, { label: string; topRated: number; aboveStandard: number }>;
  sync: SyncInfo | null;
}

export interface ListingTrafficRow {
  itemId: string;
  title: string | null;
  price: number | null;
  imageUrl: string | null;
  active: boolean | null;
  lastOptimizedAt: string | null;
  impressions: number;
  views: number;
  transactions: number;
  ctr: number | null;
  conversion: number | null;
}

export interface ListingTrafficResponse {
  top: ListingTrafficRow[];
  noSales: ListingTrafficRow[];
  noSalesMinViews: number;
  period: { start: string; end: string } | null;
}

export const LEVEL_LABEL: Record<string, string> = {
  TOP_RATED: "Top Rated",
  ABOVE_STANDARD: "Above Standard",
  BELOW_STANDARD: "Below Standard",
};
