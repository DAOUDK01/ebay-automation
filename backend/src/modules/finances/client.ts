/**
 * Finances API client. The Finances API lives on a different host (apiz.ebay.com) from the other Sell APIs,
 * so this reuses the account's SellClient token/marketplace and only swaps the base URL.
 */
import { env } from "../../config/env";
import { EbayApiError, type SellClient } from "../../lib/ebay/sell";
import { logger, sleep } from "../../lib/logger";

type Query = Record<string, string | number | boolean | undefined | null>;

/** The minimal surface the finances sync needs - tests pass a fake with the same shape. */
export interface FinancesApi {
  get<T = any>(path: string, query?: Query): Promise<T>;
  paged<T = any>(path: string, key: string, query?: Query, pageSize?: number, max?: number): AsyncGenerator<T>;
}

export const financesBase = () => (env.ebay.env === "sandbox" ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com");

/** eBay requires HTTP message signatures on Finances calls for sellers in these marketplaces. */
const SIGNATURE_MARKETPLACES = new Set([
  "EBAY_GB", "EBAY_DE", "EBAY_FR", "EBAY_IT", "EBAY_ES", "EBAY_AT", "EBAY_BE", "EBAY_NL", "EBAY_IE", "EBAY_PL", "EBAY_CH",
]);
export const needsDigitalSignature = (marketplaceId?: string) => SIGNATURE_MARKETPLACES.has(marketplaceId || "EBAY_US");

const qs = (q?: Query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export class FinancesClient implements FinancesApi {
  constructor(
    private token: () => Promise<string>,
    private marketplaceId = "EBAY_US",
    private base = financesBase(),
  ) {}

  /** Same token and marketplace as the account's SellClient. */
  static fromSell(sell: SellClient) {
    return new FinancesClient((sell as any).token as () => Promise<string>, sell.marketplaceId);
  }

  async get<T = any>(path: string, query?: Query): Promise<T> {
    const url = `${this.base}${path}${qs(query)}`;
    for (let i = 1; ; i++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            Accept: "application/json",
            "X-EBAY-C-MARKETPLACE-ID": this.marketplaceId,
          },
        });
      } catch (e: any) {
        if (i >= 3) throw new EbayApiError(`eBay Finances network error: ${e?.message ?? e}`, 0, null);
        await sleep(1000 * i);
        continue;
      }
      const text = await res.text();
      let body: any = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (res.ok) return body as T;
      if ((res.status === 429 || res.status >= 500) && i < 3) {
        logger.warn(`GET ${path} -> ${res.status}, retry ${i}`);
        await sleep(1500 * i);
        continue;
      }
      const e = body?.errors?.[0];
      throw new EbayApiError(`eBay Finances ${res.status}: ${String(e?.longMessage || e?.message || "request failed").slice(0, 400)}`, res.status, body);
    }
  }

  async *paged<T = any>(path: string, key: string, query: Query = {}, pageSize = 200, max = 10_000): AsyncGenerator<T> {
    let offset = 0;
    let seen = 0;
    for (;;) {
      const page: any = await this.get(path, { ...query, limit: pageSize, offset });
      const rows: T[] = page?.[key] ?? [];
      for (const r of rows) {
        yield r;
        if (++seen >= max) return;
      }
      offset += rows.length;
      if (!rows.length || offset >= (page?.total ?? 0)) return;
    }
  }
}
