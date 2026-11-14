/** eBay Trading API (XML). Used because it works for ALL listings, including ones created in Seller Hub. */
import { XMLParser } from "fast-xml-parser";
import { env } from "../../config/env";
import { logger, sleep } from "../logger";
import type { ActiveListingSummary, CompatRow, EbayItem, ListingChanges, Specifics } from "./types";

const COMPAT_LEVEL = "1349";
const ARRAY_TAGS = new Set([
  "Item", "NameValueList", "Value", "Compatibility", "Errors", "ShippingServiceOptions", "PictureURL",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

export class EbayApiError extends Error {}

/** Trading API <Site> code -> numeric site id (header X-EBAY-API-SITEID). eBay Motors items live on site 100. */
const SITE_IDS: Record<string, number> = {
  US: 0, eBayMotors: 100, Canada: 2, UK: 3, Australia: 15, Austria: 16, France: 71, Germany: 77,
  Italy: 101, Spain: 186, Ireland: 205, CanadaFrench: 210, HongKong: 201, Singapore: 216,
};
export const siteIdFor = (site: string | undefined, fallback = 0) =>
  site && site in SITE_IDS ? SITE_IDS[site] : fallback;

export const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const txt = (v: any): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
};
const num = (v: any) => Number(txt(v) || 0) || 0;

export function htmlToText(html: string, limit = 2500): string {
  return (html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** <ItemCompatibilityList> -> rows like { Year, Make, Model, Trim, Engine } (eBay catalog spelling). */
export function parseCompatibility(it: any): CompatRow[] {
  const out: CompatRow[] = [];
  for (const c of it?.ItemCompatibilityList?.Compatibility ?? []) {
    const row: CompatRow = {};
    for (const nv of c.NameValueList ?? []) {
      const n = txt(nv.Name);
      if (n) row[n] = txt((nv.Value ?? [])[0]);
    }
    if (Object.keys(row).length) out.push(row);
  }
  return out;
}

/** Pure function: Trading GetItem <Item> object -> normalized EbayItem. Exported for tests. */
export function normalizeItem(itemId: string, it: any): EbayItem {
  const specifics: Specifics = {};
  for (const nv of it.ItemSpecifics?.NameValueList ?? []) {
    const name = txt(nv.Name);
    if (name) specifics[name] = (nv.Value ?? []).map(txt).filter(Boolean);
  }
  const compat = parseCompatibility(it);
  const pics = it.PictureDetails?.PictureURL ?? [];
  return {
    itemId,
    title: txt(it.Title),
    subtitle: txt(it.SubTitle),
    sku: txt(it.SKU),
    listingType: txt(it.ListingType),
    categoryId: txt(it.PrimaryCategory?.CategoryID),
    categoryName: txt(it.PrimaryCategory?.CategoryName),
    conditionId: txt(it.ConditionID),
    condition: txt(it.ConditionDisplayName),
    price: num(it.StartPrice),
    currency: it.StartPrice?.["@_currencyID"] ?? "USD",
    quantity: num(it.Quantity),
    quantitySold: num(it.SellingStatus?.QuantitySold),
    watchCount: num(it.WatchCount),
    hasVariations: it.Variations !== undefined,
    variationNames: (it.Variations?.VariationSpecificsSet?.NameValueList ?? []).map((nv: any) => txt(nv.Name)),
    itemSpecifics: specifics,
    compatibilityCount: compat.length,
    compatibilitySample: compat.slice(0, 25),
    compatibilityAll: compat,
    shipping: {
      options: (it.ShippingDetails?.ShippingServiceOptions ?? []).map((so: any) => ({
        service: txt(so.ShippingService),
        cost: txt(so.ShippingServiceCost) || "0",
        free: txt(so.FreeShipping) === "true",
      })),
      dispatchDays: txt(it.DispatchTimeMax),
      policy: txt(it.SellerProfiles?.SellerShippingProfile?.ShippingProfileName),
      location: txt(it.Location),
    },
    pictureCount: pics.length,
    imageUrl: txt(pics[0]),
    descriptionText: htmlToText(txt(it.Description)),
    url: txt(it.ListingDetails?.ViewItemURL),
    site: txt(it.Site),
  };
}

/** Pure function: ListingChanges -> <Item> XML for ReviseFixedPriceItem. Exported for tests. */
export function buildReviseXml(itemId: string, changes: ListingChanges): string {
  const parts = [`<ItemID>${xmlEscape(itemId)}</ItemID>`];
  if (changes.title) parts.push(`<Title>${xmlEscape(changes.title)}</Title>`);
  if (changes.price) parts.push(`<StartPrice>${changes.price.toFixed(2)}</StartPrice>`);
  if (changes.itemSpecifics) {
    const nvs = Object.entries(changes.itemSpecifics)
      .map(([name, values]) => {
        const vals = values.filter(Boolean).map((v) => `<Value>${xmlEscape(v)}</Value>`).join("");
        return vals ? `<NameValueList><Name>${xmlEscape(name)}</Name>${vals}</NameValueList>` : "";
      })
      .join("");
    parts.push(`<ItemSpecifics>${nvs}</ItemSpecifics>`);
  }
  if (changes.compatibilityAdd?.length) {
    const rows = changes.compatibilityAdd
      .map((row) => {
        const nvs = Object.entries(row)
          .filter(([, v]) => v)
          .map(([k, v]) => `<NameValueList><Name>${xmlEscape(k)}</Name><Value>${xmlEscape(v)}</Value></NameValueList>`)
          .join("");
        return `<Compatibility>${nvs}</Compatibility>`;
      })
      .join("");
    parts.push(`<ItemCompatibilityList><ReplaceAll>false</ReplaceAll>${rows}</ItemCompatibilityList>`);
  }
  return `<Item>${parts.join("")}</Item>`;
}

export class TradingClient {
  constructor(private getToken: () => Promise<string>, private siteId = 0) {}

  async call(name: string, innerXml: string, retries = 3, siteId = this.siteId): Promise<any> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${innerXml}</${name}Request>`;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${env.ebay.apiBase}/ws/api.dll`, {
          method: "POST",
          headers: {
            "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
            "X-EBAY-API-CALL-NAME": name,
            "X-EBAY-API-SITEID": String(siteId),
            "X-EBAY-API-IAF-TOKEN": await this.getToken(),
            "Content-Type": "text/xml",
          },
          body,
        });
      } catch (e) {
        logger.warn(`${name} network error, retry ${attempt}`, e);
        await sleep(10_000 * attempt);
        continue;
      }
      if (res.status >= 500) {
        logger.warn(`${name} HTTP ${res.status}, retry ${attempt}`);
        await sleep(10_000 * attempt);
        continue;
      }
      const doc = parser.parse(await res.text());
      const root = doc[`${name}Response`] ?? {};
      const ack = txt(root.Ack);
      const errors: any[] = root.Errors ?? [];
      if (ack === "Success" || ack === "Warning") return root;
      const msgs = errors
        .filter((e) => txt(e.SeverityCode) === "Error")
        .map((e) => `[${txt(e.ErrorCode)}] ${txt(e.LongMessage)}`);
      if (msgs.some((m) => m.startsWith("[518]"))) {
        logger.warn("eBay daily call limit reached - waiting 30 min");
        await sleep(30 * 60_000);
        continue;
      }
      throw new EbayApiError(`${name} failed: ${msgs.join("; ") || `HTTP ${res.status}`}`);
    }
    throw new EbayApiError(`${name} failed after ${retries} attempts`);
  }

  async getUserId(): Promise<string> {
    const root = await this.call("GetUser", "");
    return txt(root.User?.UserID);
  }

  async activeListingsPage(page: number, perPage = 200): Promise<{ items: ActiveListingSummary[]; pages: number }> {
    const root = await this.call(
      "GetMyeBaySelling",
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>${perPage}</EntriesPerPage>` +
        `<PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`,
    );
    const active = root.ActiveList;
    if (!active) return { items: [], pages: 0 };
    const items = (active.ItemArray?.Item ?? []).map((it: any) => ({
      itemId: txt(it.ItemID),
      title: txt(it.Title),
      sku: txt(it.SKU),
      price: num(it.SellingStatus?.CurrentPrice),
      quantitySold: num(it.SellingStatus?.QuantitySold),
      watchCount: num(it.WatchCount),
      listingType: txt(it.ListingType),
      imageUrl: txt(it.PictureDetails?.GalleryURL),
    }));
    return { items, pages: num(active.PaginationResult?.TotalNumberOfPages) };
  }

  async allActiveListings(): Promise<ActiveListingSummary[]> {
    const out: ActiveListingSummary[] = [];
    for (let page = 1; ; page++) {
      const { items, pages } = await this.activeListingsPage(page);
      out.push(...items);
      if (page >= pages || !items.length) return out;
    }
  }

  async getItem(itemId: string): Promise<EbayItem> {
    const root = await this.call(
      "GetItem",
      `<ItemID>${xmlEscape(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel>` +
        `<IncludeItemSpecifics>true</IncludeItemSpecifics><IncludeItemCompatibilityList>true</IncludeItemCompatibilityList>` +
        `<IncludeWatchCount>true</IncludeWatchCount>`,
    );
    const it = (root.Item ?? [])[0];
    if (!it) throw new EbayApiError(`GetItem returned no item for ${itemId}`);
    return normalizeItem(itemId, it);
  }

  /** Compatibility table of ANY public listing (used to learn fitment from other listings of the same part number). */
  async getItemCompatibility(itemId: string): Promise<{ itemId: string; title: string; rows: CompatRow[] }> {
    const root = await this.call(
      "GetItem",
      `<ItemID>${xmlEscape(itemId)}</ItemID><IncludeItemCompatibilityList>true</IncludeItemCompatibilityList>` +
        `<OutputSelector>Item.ItemID</OutputSelector><OutputSelector>Item.Title</OutputSelector>` +
        `<OutputSelector>Item.ItemCompatibilityList</OutputSelector>`,
    );
    const it = (root.Item ?? [])[0];
    return { itemId, title: txt(it?.Title), rows: parseCompatibility(it) };
  }

  /** Returns warning messages (if any). Throws on failure.
   *  `site` = the listing's <Site> from GetItem (e.g. "eBayMotors"), so the revise goes to the right eBay site. */
  async reviseItem(itemId: string, changes: ListingChanges, site?: string): Promise<string[]> {
    const root = await this.call("ReviseFixedPriceItem", buildReviseXml(itemId, changes), 3, siteIdFor(site, this.siteId));
    return (root.Errors ?? []).map((e: any) => txt(e.LongMessage)).filter(Boolean);
  }
}
