/** Read side + user-clicked writes for Promoted Listings and item promotions. */
import type { Types } from "mongoose";
import type { SellClient } from "../../lib/ebay/sell";
import type { SyncContext, SyncResult } from "../types";
import {
  buildBulkAdsPayloads,
  buildBulkBidPayloads,
  buildBulkDeletePayloads,
  buildCampaignPayload,
  buildIdentificationPayload,
  MARKETING,
  mapAd,
  mapCampaign,
  mapPromotion,
  type CampaignAction,
  type CampaignEdit,
  type NewCampaign,
} from "./logic";
import { Ad, Campaign, ItemPromotion } from "./models";

/** The part of SellClient this module uses (tests pass a fake). */
export type MarketingApi = Pick<SellClient, "get" | "post" | "paged">;

/** Re-read one campaign and its ads from eBay into the local copy. */
export async function refreshCampaign(sell: MarketingApi, storeId: Types.ObjectId, raw: any) {
  const c = mapCampaign(raw);
  const ads: ReturnType<typeof mapAd>[] = [];
  if (c.status !== "ENDED" && c.status !== "DELETED") {
    for await (const a of sell.paged(`${MARKETING}/ad_campaign/${c.campaignId}/ad`, "ads", {}, 500)) ads.push(mapAd(c.campaignId, a));
    await Ad.deleteMany({ storeId, campaignId: c.campaignId, adId: { $nin: ads.map((a) => a.adId) } });
    if (ads.length) {
      await Ad.bulkWrite(
        ads.map((a) => ({ updateOne: { filter: { storeId, campaignId: c.campaignId, adId: a.adId }, update: { $set: a }, upsert: true } })),
      );
    }
  }
  const adCount = c.status === "ENDED" || c.status === "DELETED" ? await Ad.countDocuments({ storeId, campaignId: c.campaignId }) : ads.length;
  await Campaign.updateOne({ storeId, campaignId: c.campaignId }, { $set: { ...c, adCount } }, { upsert: true });
  return { ...c, adCount };
}

export async function syncPromotions(ctx: SyncContext): Promise<SyncResult> {
  const { sell } = ctx.clients;
  const storeId = ctx.store._id;
  const mp = ctx.store.marketplaceId || "EBAY_US";

  const seen: string[] = [];
  let running = 0;
  for await (const raw of sell.paged(`${MARKETING}/ad_campaign`, "campaigns", {}, 100)) {
    const c = await refreshCampaign(sell, storeId, raw);
    seen.push(c.campaignId);
    if (c.status === "RUNNING") running++;
  }
  // campaigns deleted on eBay
  const gone = await Campaign.find({ storeId, campaignId: { $nin: seen } }, { campaignId: 1 }).lean();
  if (gone.length) {
    await Campaign.deleteMany({ storeId, campaignId: { $in: gone.map((g) => g.campaignId) } });
    await Ad.deleteMany({ storeId, campaignId: { $in: gone.map((g) => g.campaignId) } });
  }

  const promoIds: string[] = [];
  for await (const raw of sell.paged(`${MARKETING}/promotion`, "promotions", { marketplace_id: mp }, 200)) {
    const p = mapPromotion(raw);
    promoIds.push(p.promotionId);
    await ItemPromotion.updateOne({ storeId, promotionId: p.promotionId }, { $set: p }, { upsert: true });
  }
  await ItemPromotion.deleteMany({ storeId, promotionId: { $nin: promoIds } });

  return { summary: `${seen.length} campaigns (${running} running), ${promoIds.length} item promotions` };
}

// ---------------------------------------------------------------- writes (only ever called from a confirmed click)

export async function createCampaign(sell: MarketingApi, storeId: Types.ObjectId, marketplaceId: string, input: NewCampaign) {
  const body = buildCampaignPayload(input, marketplaceId);
  await sell.post(`${MARKETING}/ad_campaign`, body);
  // eBay answers 201 with only a Location header: look the new campaign up by name
  const raw = await sell.get(`${MARKETING}/ad_campaign/get_campaign_by_name`, { campaign_name: body.campaignName });
  return raw?.campaignId ? refreshCampaign(sell, storeId, raw) : null;
}

export async function campaignAction(sell: MarketingApi, storeId: Types.ObjectId, campaignId: string, action: CampaignAction) {
  await sell.post(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}/${action}`);
  const raw = await sell.get(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}`);
  return refreshCampaign(sell, storeId, raw);
}

export interface AdResult {
  listingId: string;
  ok: boolean;
  adId?: string;
  error?: string;
}

const reread = async (sell: MarketingApi, storeId: Types.ObjectId, campaignId: string) =>
  refreshCampaign(sell, storeId, await sell.get(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}`));

/** Per-listing results of a bulk ads call (eBay answers 207 with one entry per listing). */
const bulkResults = (r: any): AdResult[] =>
  (r?.responses ?? []).map((x: any) => {
    const ok = !x.statusCode || x.statusCode < 300;
    return { listingId: String(x.listingId), ok, adId: x.adId, error: ok ? undefined : x.errors?.[0]?.message ?? `status ${x.statusCode}` };
  });

/** Rename a campaign / change its dates. */
export async function editCampaign(
  sell: MarketingApi,
  storeId: Types.ObjectId,
  current: { campaignId: string; startDate?: Date | null; status?: string | null },
  input: CampaignEdit,
) {
  const body = buildIdentificationPayload(input, current);
  await sell.post(`${MARKETING}/ad_campaign/${encodeURIComponent(current.campaignId)}/update_campaign_identification`, body);
  return reread(sell, storeId, current.campaignId);
}

/** New ad rate for some (or all) listings in a campaign. */
export async function updateAdRates(sell: MarketingApi, storeId: Types.ObjectId, campaignId: string, listingIds: string[], bidPercentage: number) {
  const results: AdResult[] = [];
  for (const body of buildBulkBidPayloads(listingIds, bidPercentage)) {
    results.push(...bulkResults(await sell.post(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}/bulk_update_ads_bid_by_listing_id`, body)));
  }
  return { results, campaign: await reread(sell, storeId, campaignId) };
}

/** Take listings out of a campaign (their ads are deleted; the listings themselves are untouched). */
export async function removeListings(sell: MarketingApi, storeId: Types.ObjectId, campaignId: string, listingIds: string[]) {
  const results: AdResult[] = [];
  for (const body of buildBulkDeletePayloads(listingIds)) {
    results.push(...bulkResults(await sell.post(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}/bulk_delete_ads_by_listing_id`, body)));
  }
  return { results, campaign: await reread(sell, storeId, campaignId) };
}

export async function addListings(sell: MarketingApi, storeId: Types.ObjectId, campaignId: string, listingIds: string[], bidPercentage: number) {
  const results: AdResult[] = [];
  for (const body of buildBulkAdsPayloads(listingIds, bidPercentage)) {
    const r: any = await sell.post(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}/bulk_create_ads_by_listing_id`, body);
    for (const x of r?.responses ?? []) {
      const ok = !!x.adId && (!x.statusCode || x.statusCode < 300);
      results.push({ listingId: String(x.listingId), ok, adId: x.adId, error: ok ? undefined : x.errors?.[0]?.message ?? `status ${x.statusCode}` });
    }
  }
  const raw = await sell.get(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}`);
  const campaign = await refreshCampaign(sell, storeId, raw);
  return { results, campaign };
}
