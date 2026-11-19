/**
 * "Policy fixes": active listings whose current shipping policy differs from what analyzeShipping /
 * pickPolicy suggests. Built from the latest shipping analysis saved on each listing's proposals; with
 * `live`, it's re-run against the store's current policy list (the package weight/size stays as analysed).
 */
import type { TradingClient } from "../../lib/ebay/trading";
import type { ShippingAnalysis, ShippingPolicy } from "../../lib/ebay/types";
import { analyzeShipping } from "../../lib/shipping";
import { Listing } from "../../models/Listing";
import { Proposal } from "../../models/Proposal";
import { resolveSettings, type StoreDocument } from "../../models/Store";

export interface PolicyFix {
  itemId: string;
  title: string;
  imageUrl: string;
  price: number | null;
  current: ShippingAnalysis["current"];
  suggested: NonNullable<ShippingAnalysis["suggested"]>;
  note: string;
  billableKg: number;
  categoryKg: number;
  source: ShippingAnalysis["source"];
  rule?: ShippingAnalysis["rule"];
  analysedAt: Date;
  /** the same change is waiting in an optimizer batch */
  pendingInBatch: boolean;
  /** the full analysis behind this row */
  analysis: ShippingAnalysis;
}

const samePolicy = (a: { id: string; name: string } | null | undefined, b: { id: string; name: string } | null | undefined) =>
  Boolean(a && b && (a.id && b.id ? a.id === b.id : a.name === b.name));

export async function listPolicyFixes(store: StoreDocument, policies?: ShippingPolicy[]): Promise<PolicyFix[]> {
  const latest = await Proposal.aggregate([
    { $match: { storeId: store._id, shipping: { $ne: null } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$itemId", p: { $first: "$$ROOT" } } },
  ]);
  if (!latest.length) return [];
  const listings = await Listing.find({ storeId: store._id, active: true, itemId: { $in: latest.map((l: any) => l._id) } })
    .select("itemId title imageUrl price")
    .lean();
  const byId = new Map(listings.map((l) => [l.itemId, l]));
  const settings = resolveSettings(store.settings).modules.shipping;
  const out: PolicyFix[] = [];
  for (const { p } of latest as any[]) {
    const listing = byId.get(p.itemId);
    if (!listing) continue;
    let a = p.shipping as ShippingAnalysis;
    const changes = p.changes ?? {};
    // already pushed with this policy -> the listing has it now
    if (p.status === "pushed" && changes.shippingPolicyId && changes.shippingPolicyId === a.suggested?.id) continue;
    if (policies?.length && a.package && a.current) {
      a = analyzeShipping(
        {
          title: listing.title ?? "",
          shipping: { options: [], dispatchDays: "", location: "", policy: a.current.name, policyId: a.current.id, package: a.package },
        },
        undefined,
        policies,
        settings,
      );
      a.source = (p.shipping as ShippingAnalysis).source;
    }
    if (a.matches || !a.suggested?.id || samePolicy(a.current, a.suggested)) continue;
    out.push({
      itemId: p.itemId,
      title: listing.title ?? "",
      imageUrl: listing.imageUrl ?? "",
      price: listing.price ?? null,
      current: a.current,
      suggested: a.suggested,
      note: a.note,
      billableKg: a.billableKg,
      categoryKg: a.categoryKg,
      source: a.source,
      rule: a.rule,
      analysedAt: p.createdAt,
      pendingInBatch: ["proposed", "approved"].includes(p.status) && changes.shippingPolicyId === a.suggested.id,
      analysis: a,
    });
  }
  return out.sort((x, y) => x.title.localeCompare(y.title));
}

/**
 * Switch one listing to the suggested policy (user click + confirm only). Takes a fresh snapshot first so
 * the change shows in Change history and can be reverted.
 */
export async function applyPolicyFix(
  store: StoreDocument,
  trading: Pick<TradingClient, "getItem" | "reviseItem">,
  fix: PolicyFix,
) {
  const before = await trading.getItem(fix.itemId);
  if (before.shipping?.policyId && before.shipping.policyId === fix.suggested.id) {
    return { warnings: [] as string[], alreadySet: true };
  }
  const warnings = await trading.reviseItem(fix.itemId, { shippingPolicyId: fix.suggested.id }, before.site);
  const current = before.shipping?.policyId ? { id: before.shipping.policyId, name: before.shipping.policy, kg: fix.current?.kg ?? null } : fix.current;
  await Proposal.create({
    storeId: store._id,
    batchId: null,
    kind: "manual",
    itemId: fix.itemId,
    status: "pushed",
    before,
    changes: { shippingPolicyId: fix.suggested.id },
    notes: [`shipping policy: ${current?.name || "none"} -> ${fix.suggested.name} (Shipping > Policy fixes)`],
    shipping: { ...fix.analysis, current: fix.suggested, suggested: fix.suggested, matches: true, note: `Changed from "${current?.name || "none"}" (Policy fixes)` },
    warnings,
    pushedAt: new Date(),
  });
  return { warnings, alreadySet: false };
}
