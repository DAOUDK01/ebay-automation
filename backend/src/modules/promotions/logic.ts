/** Pure Promotions helpers: map Marketing API payloads and build the request bodies for writes. */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const date = (v: unknown) => (v ? new Date(String(v)) : undefined);

export const MARKETING = "/sell/marketing/v1";
/** eBay accepts ad rates from 2% to 100%, one decimal */
export const MIN_BID = 2;
export const MAX_BID = 100;
/** bulk_create_ads_by_listing_id takes at most 500 listings per call */
export const BULK_LIMIT = 500;

export function mapCampaign(c: any) {
  return {
    campaignId: String(c.campaignId),
    name: c.campaignName,
    status: c.campaignStatus,
    fundingModel: c.fundingStrategy?.fundingModel,
    bidPercentage: num(c.fundingStrategy?.bidPercentage),
    marketplaceId: c.marketplaceId,
    startDate: date(c.startDate),
    endDate: date(c.endDate),
    rulesBased: !!c.campaignCriterion?.autoSelectFutureInventory || !!c.campaignCriterion?.selectionRules?.length,
  };
}

export function mapAd(campaignId: string, a: any) {
  return {
    campaignId,
    adId: String(a.adId),
    listingId: a.listingId ? String(a.listingId) : undefined,
    bidPercentage: num(a.bidPercentage),
    status: a.adStatus,
  };
}

export function mapPromotion(p: any) {
  return {
    promotionId: String(p.promotionId),
    name: p.name,
    type: p.promotionType,
    status: p.promotionStatus,
    description: p.description,
    startDate: date(p.startDate),
    endDate: date(p.endDate),
    href: p.promotionHref,
  };
}

/** "5" -> "5.0" (eBay wants a decimal string) */
export const bidString = (pct: number) => {
  if (!Number.isFinite(pct) || pct < MIN_BID || pct > MAX_BID) throw new Error(`Ad rate must be between ${MIN_BID}% and ${MAX_BID}%`);
  return (Math.round(pct * 10) / 10).toFixed(1);
};

export interface NewCampaign {
  name: string;
  bidPercentage: number;
  /** YYYY-MM-DD or ISO; today or past = start now */
  startDate: string;
  endDate?: string | null;
}

/** createCampaign body for a Promoted Listings Standard (cost-per-sale) campaign. */
export function buildCampaignPayload(input: NewCampaign, marketplaceId: string, now = new Date()) {
  const start = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) ? `${input.startDate}T00:00:00Z` : input.startDate);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid start date");
  // eBay rejects a start in the past: anything up to now starts in a few minutes
  const startDate = start.getTime() <= now.getTime() ? new Date(now.getTime() + 5 * 60_000) : start;
  let endDate: Date | undefined;
  if (input.endDate) {
    endDate = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? `${input.endDate}T23:59:59Z` : input.endDate);
    if (Number.isNaN(endDate.getTime()) || endDate <= startDate) throw new Error("End date must be after the start date");
  }
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error("Campaign name must be 1-80 characters");
  return {
    campaignName: name,
    marketplaceId,
    startDate: startDate.toISOString(),
    ...(endDate ? { endDate: endDate.toISOString() } : {}),
    fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: bidString(input.bidPercentage) },
  };
}

/** bulk_create_ads_by_listing_id bodies (chunks of 500, duplicates removed). */
export function buildBulkAdsPayloads(listingIds: string[], bidPercentage: number) {
  const bid = bidString(bidPercentage);
  const ids = [...new Set(listingIds.map((s) => String(s).trim()).filter((s) => /^\d{9,19}$/.test(s)))];
  const out: { requests: { listingId: string; bidPercentage: string }[] }[] = [];
  for (let i = 0; i < ids.length; i += BULK_LIMIT) out.push({ requests: ids.slice(i, i + BULK_LIMIT).map((listingId) => ({ listingId, bidPercentage: bid })) });
  return out;
}

/** bulk_update_ads_bid_by_listing_id bodies - same shape and limits as creating ads. */
export const buildBulkBidPayloads = buildBulkAdsPayloads;

/** bulk_delete_ads_by_listing_id bodies (chunks of 500). */
export function buildBulkDeletePayloads(listingIds: string[]) {
  const ids = [...new Set(listingIds.map((s) => String(s).trim()).filter((s) => /^\d{9,19}$/.test(s)))];
  const out: { requests: { listingId: string }[] }[] = [];
  for (let i = 0; i < ids.length; i += BULK_LIMIT) out.push({ requests: ids.slice(i, i + BULK_LIMIT).map((listingId) => ({ listingId })) });
  return out;
}

export interface CampaignEdit {
  name: string;
  /** only used while the campaign hasn't started yet */
  startDate?: string | null;
  /** "" / null = no end date */
  endDate?: string | null;
}

/**
 * update_campaign_identification body. eBay keeps the start date of a campaign that already started,
 * so we resend the current one then; a new end date must be after both the start and now.
 */
export function buildIdentificationPayload(input: CampaignEdit, current: { startDate?: Date | string | null; status?: string | null }, now = new Date()) {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error("Campaign name must be 1-80 characters");
  const day = (v: string, end: boolean) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? "23:59:59" : "00:00:00"}Z` : v);
  const started = current.status === "RUNNING" || current.status === "PAUSED" || current.status === "SYSTEM_PAUSED" || current.status === "ENDING_SOON";
  let start = current.startDate ? new Date(current.startDate) : now;
  if (!started && input.startDate) {
    start = day(input.startDate, false);
    if (Number.isNaN(start.getTime())) throw new Error("Invalid start date");
    if (start.getTime() <= now.getTime()) start = new Date(now.getTime() + 5 * 60_000);
  }
  let end: Date | undefined;
  if (input.endDate) {
    end = day(input.endDate, true);
    if (Number.isNaN(end.getTime()) || end <= start || end <= now) throw new Error("End date must be in the future and after the start date");
  }
  return { campaignName: name, startDate: start.toISOString(), ...(end ? { endDate: end.toISOString() } : {}) };
}

export type CampaignAction = "pause" | "resume" | "end";
/** Which status a campaign can go to from where it is. */
export function canDo(status: string | undefined | null, action: CampaignAction) {
  if (action === "pause") return status === "RUNNING" || status === "SCHEDULED";
  if (action === "resume") return status === "PAUSED";
  return status !== "ENDED" && status !== "DELETED";
}
