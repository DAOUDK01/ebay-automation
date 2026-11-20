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

export type RangeDays = 7 | 30 | 90;

export interface TrafficTotals {
  impressions: number;
  views: number;
  transactions: number;
  ctr: number | null;
  conversion: number | null;
}

export interface AnalyticsOverview {
  hasData: boolean;
  range: { days: RangeDays; start: string; end: string };
  days: TrafficDayPoint[];
  totals: TrafficTotals;
  previous: TrafficTotals | null;
  change: { impressions: number | null; views: number | null; transactions: number | null } | null;
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

export interface SalesTotals {
  orders: number;
  revenue: number;
  units: number;
  avgOrderValue: number;
  cancelled: number;
  refunded: number;
  refundAmount: number;
}

export interface SalesReport {
  hasOrders: boolean;
  range: { days: RangeDays; start: string; end: string };
  currency: string;
  totals: SalesTotals;
  previous: SalesTotals;
  change: { revenue: number | null; orders: number | null; units: number | null; avgOrderValue: number | null };
  days: { day: string; revenue: number; orders: number }[];
  topItems: { itemId: string; title: string; image: string; units: number; revenue: number; orders: number }[];
  weekday: { day: string; orders: number; revenue: number }[];
}
