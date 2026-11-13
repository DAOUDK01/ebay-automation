/** eBay REST APIs: Browse (competitor search) and Taxonomy (category item specifics). */
import { env } from "../../config/env";
import { logger, sleep } from "../logger";
import { appAccessToken } from "./auth";
import type { Aspect, Competitor, EbayItem } from "./types";

const aspectCache = new Map<string, { at: number; aspects: Aspect[] }>();
const treeIdCache = new Map<string, string>();
const ASPECT_TTL = 24 * 3600_000;

export class RestClient {
  constructor(private marketplaceId = "EBAY_US") {}

  private async get(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = `${env.ebay.apiBase}${path}?${new URLSearchParams(params).toString()}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${await appAccessToken()}`, "X-EBAY-C-MARKETPLACE-ID": this.marketplaceId },
      });
      if (res.status === 429 || res.status >= 500) {
        logger.warn(`GET ${path} -> ${res.status}, retry ${attempt}`);
        await sleep(15_000 * attempt);
        continue;
      }
      if (res.status === 204) return {};
      const text = await res.text();
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 400)}`);
      return JSON.parse(text);
    }
    throw new Error(`GET ${path} failed after retries`);
  }

  async categoryTreeId(): Promise<string> {
    const cached = treeIdCache.get(this.marketplaceId);
    if (cached) return cached;
    const j = await this.get("/commerce/taxonomy/v1/get_default_category_tree_id", { marketplace_id: this.marketplaceId });
    treeIdCache.set(this.marketplaceId, j.categoryTreeId);
    return j.categoryTreeId;
  }

  async aspectsForCategory(categoryId: string): Promise<Aspect[]> {
    const key = `${this.marketplaceId}:${categoryId}`;
    const c = aspectCache.get(key);
    if (c && Date.now() - c.at < ASPECT_TTL) return c.aspects;
    const tree = await this.categoryTreeId();
    const j = await this.get(`/commerce/taxonomy/v1/category_tree/${tree}/get_item_aspects_for_category`, {
      category_id: categoryId,
    });
    const aspects: Aspect[] = (j.aspects ?? []).map((a: any) => {
      const con = a.aspectConstraint ?? {};
      return {
        name: a.localizedAspectName,
        required: Boolean(con.aspectRequired),
        usage: con.aspectUsage ?? "OPTIONAL",
        mode: con.aspectMode ?? "FREE_TEXT",
        multi: con.itemToAspectCardinality === "MULTI",
        maxLength: con.aspectMaxLength,
        values: (a.aspectValues ?? []).map((v: any) => v.localizedValue),
      };
    });
    aspectCache.set(key, { at: Date.now(), aspects });
    return aspects;
  }

  async search(q: string, opts: { categoryId?: string; conditionId?: string; excludeSeller?: string; limit?: number }) {
    const filters = ["buyingOptions:{FIXED_PRICE}"];
    if (this.marketplaceId === "EBAY_US") filters.push("itemLocationCountry:US");
    if (opts.conditionId) filters.push(`conditionIds:{${opts.conditionId}}`);
    if (opts.excludeSeller) filters.push(`excludeSellers:{${opts.excludeSeller}}`);
    const params: Record<string, string> = { q: q.slice(0, 100), limit: String(opts.limit ?? 15), filter: filters.join(",") };
    if (opts.categoryId) params.category_ids = opts.categoryId;
    const j = await this.get("/buy/browse/v1/item_summary/search", params);
    return (j.itemSummaries ?? []).map(
      (s: any): Competitor => ({
        title: s.title,
        price: Number(s.price?.value ?? 0),
        shipping: s.shippingOptions?.[0]?.shippingCost ? Number(s.shippingOptions[0].shippingCost.value) : null,
        condition: s.condition ?? "",
        sellerFeedback: s.seller?.feedbackScore ?? null,
        sellerPositivePct: s.seller?.feedbackPercentage ?? null,
        topRated: Boolean(s.topRatedBuyingExperience),
        url: s.itemWebUrl ?? "",
      }),
    );
  }

  /** Part number first (most precise), then a shortened title. */
  async competitorsFor(item: EbayItem, excludeSeller = "", limit = 15): Promise<{ query: string; competitors: Competitor[] }> {
    const queries: string[] = [];
    for (const key of ["Manufacturer Part Number", "MPN", "Interchange Part Number", "OE/OEM Part Number"]) {
      const v = item.itemSpecifics[key]?.[0];
      if (v && !["does not apply", "n/a", "na"].includes(v.toLowerCase())) {
        queries.push(v);
        break;
      }
    }
    const words = item.title.replace(/[^\w\s\-/.]/g, " ").split(/\s+/).filter(Boolean);
    queries.push(words.slice(0, 8).join(" "), words.slice(0, 5).join(" "));
    let used = "";
    let res: Competitor[] = [];
    for (const q of queries) {
      if (!q.trim()) continue;
      used = q;
      try {
        res = await this.search(q, { categoryId: item.categoryId, conditionId: item.conditionId, excludeSeller, limit });
      } catch (e) {
        logger.warn(`competitor search failed for "${q}"`, e);
        res = [];
      }
      if (res.length >= 3) break;
    }
    return { query: used, competitors: res };
  }
}
