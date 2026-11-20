/**
 * /api/stores/:storeId/promotions. Reads come from the synced copy; every write is a user click behind a
 * confirm dialog and must send `confirm: true`.
 */
import { Router } from "express";
import { z } from "zod";
import { clientsFor } from "../../lib/ebay/sell";
import { loadStore } from "../../middleware/auth";
import { HttpError, parseBody } from "../../middleware/error";
import { Listing } from "../../models/Listing";
import { SyncState } from "../../models/SyncState";
import { FinTransaction } from "../finances/models";
import { canDo, MAX_BID, MIN_BID } from "./logic";
import { Ad, Campaign, ItemPromotion } from "./models";
import { addListings, campaignAction, createCampaign, type MarketingApi } from "./sync";

const router = Router({ mergeParams: true });
const DAY = 86_400_000;

/** Overridable in tests. */
export const marketing = { clientFor: (store: Parameters<typeof clientsFor>[0]): MarketingApi => clientsFor(store).sell };

const confirmed = z.literal(true, { error: "Confirm this action first" });
const bid = z.coerce.number().min(MIN_BID).max(MAX_BID);

router.get("/campaigns", async (req, res) => {
  const store = await loadStore(req);
  const [campaigns, state, ads] = await Promise.all([
    Campaign.find({ storeId: store._id }).sort({ status: 1, startDate: -1 }).lean(),
    SyncState.findOne({ storeId: store._id, module: "promotions" }).lean(),
    Ad.find({ storeId: store._id }, { campaignId: 1, listingId: 1 }).lean(),
  ]);
  // simple performance summary: promoted-listing ad fees paid in the last 30 days (from Finances), per campaign
  const fees = await FinTransaction.find(
    { storeId: store._id, type: "NON_SALE_CHARGE", feeType: "AD_FEE", date: { $gte: new Date(Date.now() - 30 * DAY) } },
    { amount: 1, itemIds: 1, orderId: 1 },
  ).lean();
  const listingCampaign = new Map(ads.map((a) => [a.listingId, a.campaignId]));
  const perCampaign = new Map<string, { adFees: number; sales: Set<string> }>();
  for (const f of fees) {
    const cid = (f.itemIds ?? []).map((i) => listingCampaign.get(i)).find(Boolean);
    if (!cid) continue;
    const p = perCampaign.get(cid) ?? { adFees: 0, sales: new Set<string>() };
    p.adFees += -(f.amount ?? 0);
    if (f.orderId) p.sales.add(f.orderId);
    perCampaign.set(cid, p);
  }
  const rank = (s?: string | null) => ["RUNNING", "SCHEDULED", "PENDING", "PAUSED", "SYSTEM_PAUSED", "ENDING_SOON"].indexOf(s ?? "") + 1 || 99;
  campaigns.sort((a, b) => rank(a.status) - rank(b.status));
  res.json({
    campaigns: campaigns.map((c) => {
      const p = perCampaign.get(c.campaignId);
      return { ...c, adFees30d: p ? Math.round(p.adFees * 100) / 100 : 0, promotedSales30d: p?.sales.size ?? 0 };
    }),
    sync: state ? { lastSuccessAt: state.lastSuccessAt, lastRunAt: state.lastRunAt, summary: state.summary, error: state.error } : null,
  });
});

router.get("/campaigns/:campaignId", async (req, res) => {
  const store = await loadStore(req);
  const campaign = await Campaign.findOne({ storeId: store._id, campaignId: String(req.params.campaignId) }).lean();
  if (!campaign) throw new HttpError(404, "Campaign not found");
  const ads = await Ad.find({ storeId: store._id, campaignId: campaign.campaignId }).lean();
  const listings = await Listing.find(
    { storeId: store._id, itemId: { $in: ads.map((a) => a.listingId).filter(Boolean) as string[] } },
    { itemId: 1, title: 1, price: 1, imageUrl: 1 },
  ).lean();
  const byId = new Map(listings.map((l) => [l.itemId, l]));
  res.json({
    campaign,
    ads: ads.map((a) => ({ ...a, title: byId.get(a.listingId ?? "")?.title ?? null, price: byId.get(a.listingId ?? "")?.price ?? null })),
  });
});

/** Active listings to promote (?q= title / item ID / SKU), with the campaign each is already in. */
router.get("/listing-search", async (req, res) => {
  const store = await loadStore(req);
  const q = String(req.query.q ?? "").trim();
  const f: any = { storeId: store._id, active: true };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    f.$or = [{ title: rx }, { itemId: q }, { sku: rx }];
  }
  const listings = await Listing.find(f, { itemId: 1, title: 1, price: 1, sku: 1, quantitySold: 1 }).sort({ quantitySold: -1 }).limit(50).lean();
  const ads = await Ad.find({ storeId: store._id, listingId: { $in: listings.map((l) => l.itemId) }, status: { $ne: "ARCHIVED" } }).lean();
  const inCampaign = new Map(ads.map((a) => [a.listingId, a.campaignId]));
  res.json({ listings: listings.map((l) => ({ ...l, campaignId: inCampaign.get(l.itemId) ?? null })) });
});

router.get("/item-promotions", async (req, res) => {
  const store = await loadStore(req);
  const promotions = await ItemPromotion.find({ storeId: store._id }).sort({ startDate: -1 }).lean();
  res.json({ promotions });
});

// ---------------------------------------------------------------- confirm-gated writes

router.post("/campaigns", async (req, res) => {
  const store = await loadStore(req);
  const body = parseBody(
    z.object({
      name: z.string().trim().min(1).max(80),
      bidPercentage: bid,
      startDate: z.string().min(8),
      endDate: z.string().nullish(),
      confirm: confirmed,
    }),
    req.body,
  );
  let campaign;
  try {
    campaign = await createCampaign(marketing.clientFor(store), store._id, store.marketplaceId || "EBAY_US", body);
  } catch (e: any) {
    throw new HttpError(e?.status && e.status < 500 ? 400 : 502, e?.message ?? "eBay error");
  }
  res.status(201).json({ campaign });
});

router.post("/campaigns/:campaignId/:action", async (req, res, next) => {
  const action = String(req.params.action);
  if (!["pause", "resume", "end"].includes(action)) return next("route");
  const store = await loadStore(req);
  parseBody(z.object({ confirm: confirmed }), req.body);
  const c = await Campaign.findOne({ storeId: store._id, campaignId: String(req.params.campaignId) }).lean();
  if (!c) throw new HttpError(404, "Campaign not found");
  if (!canDo(c.status, action as "pause")) throw new HttpError(409, `Can't ${action} a campaign that is ${String(c.status).toLowerCase()}`);
  try {
    res.json({ campaign: await campaignAction(marketing.clientFor(store), store._id, c.campaignId, action as "pause") });
  } catch (e: any) {
    throw new HttpError(e?.status && e.status < 500 ? 400 : 502, e?.message ?? "eBay error");
  }
});

router.post("/campaigns/:campaignId/ads", async (req, res) => {
  const store = await loadStore(req);
  const body = parseBody(z.object({ listingIds: z.array(z.string()).min(1).max(1000), bidPercentage: bid, confirm: confirmed }), req.body);
  const c = await Campaign.findOne({ storeId: store._id, campaignId: String(req.params.campaignId) }).lean();
  if (!c) throw new HttpError(404, "Campaign not found");
  if (c.status === "ENDED" || c.status === "DELETED") throw new HttpError(409, "This campaign has ended");
  if (c.fundingModel !== "COST_PER_SALE") throw new HttpError(409, "Only Promoted Listings Standard (cost per sale) campaigns are supported here");
  if (c.rulesBased) throw new HttpError(409, "This campaign picks its listings by rules - add listings on eBay");
  // only this account's listings
  const own = await Listing.find({ storeId: store._id, itemId: { $in: body.listingIds } }, { itemId: 1 }).lean();
  if (!own.length) throw new HttpError(400, "None of those listings belong to this account");
  try {
    res.json(await addListings(marketing.clientFor(store), store._id, c.campaignId, own.map((l) => l.itemId), body.bidPercentage));
  } catch (e: any) {
    throw new HttpError(e?.status && e.status < 500 ? 400 : 502, e?.message ?? "eBay error");
  }
});

export default router;
