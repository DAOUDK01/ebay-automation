/** Types for the Promotions module API (backend src/modules/promotions). */
import type { SyncInfo } from "./finances";

export interface Campaign {
  campaignId: string;
  name: string;
  status: string;
  fundingModel?: string;
  bidPercentage: number | null;
  marketplaceId?: string;
  startDate?: string;
  endDate?: string;
  adCount: number;
  rulesBased?: boolean;
  adFees30d?: number;
  promotedSales30d?: number;
}

export interface CampaignAd {
  adId: string;
  listingId?: string;
  bidPercentage: number | null;
  status?: string;
  title: string | null;
  price: number | null;
}

export interface CampaignsResponse {
  campaigns: Campaign[];
  sync: SyncInfo | null;
}

export interface CampaignDetail {
  campaign: Campaign;
  ads: CampaignAd[];
}

export interface PromotableListing {
  itemId: string;
  title?: string;
  price?: number;
  sku?: string;
  quantitySold?: number;
  campaignId: string | null;
}

export interface ItemPromotion {
  promotionId: string;
  name: string;
  type: string;
  status: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

export interface AdResult {
  listingId: string;
  ok: boolean;
  adId?: string;
  error?: string;
}

export const MIN_BID = 2;
export const MAX_BID = 100;

export const CAMPAIGN_STATUS_COLOR: Record<string, "green" | "yellow" | "gray" | "blue" | "red"> = {
  RUNNING: "green",
  SCHEDULED: "blue",
  PENDING: "blue",
  PAUSED: "yellow",
  SYSTEM_PAUSED: "yellow",
  ENDING_SOON: "yellow",
  ENDED: "gray",
  DELETED: "gray",
  DRAFT: "gray",
  INVALID: "red",
};

export const PROMOTION_TYPE_LABEL: Record<string, string> = {
  MARKDOWN_SALE: "Markdown sale",
  ORDER_DISCOUNT: "Order discount",
  VOLUME_DISCOUNT: "Volume pricing",
  CODED_COUPON: "Coupon",
};

export const statusLabel = (s?: string | null) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "—");
