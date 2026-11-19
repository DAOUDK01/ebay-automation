/**
 * User-token clients for one connected eBay account, shared by every account-management module:
 *  - SellClient: the REST "Sell" APIs (Fulfillment, Finances, Marketing, Analytics, Account, Inventory)
 *  - PostOrderClient: the Post-Order API (returns, cancellations, cases) - same token, "IAF" auth header
 *  - TradingClient: the XML Trading API (messages, feedback, relist...) - see trading.ts
 * Use `clientsFor(store)`; each client refreshes the account's token as needed.
 */
import { env } from "../../config/env";
import { decrypt } from "../crypto";
import { logger, sleep } from "../logger";
import type { StoreDocument } from "../../models/Store";
import { userAccessToken } from "./auth";
import { TradingClient } from "./trading";

export class EbayApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

const qs = (q?: Query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** First readable message from an eBay error body ({ errors: [{ message, longMessage }] }). */
function errorMessage(body: any, status: number): string {
  const e = body?.errors?.[0] ?? body?.error ?? body;
  const msg = e?.longMessage || e?.message || e?.error_description || (typeof body === "string" ? body : "");
  return `eBay API ${status}: ${String(msg || "request failed").slice(0, 400)}`;
}

abstract class BaseClient {
  constructor(protected token: () => Promise<string>) {}

  protected abstract authHeader(token: string): string;
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  /** JSON request with retries on 429 / 5xx / network errors. `path` is relative to the API host. */
  async request<T = any>(method: string, path: string, opts: { query?: Query; body?: unknown; attempts?: number } = {}): Promise<T> {
    const url = `${env.ebay.apiBase}${path}${qs(opts.query)}`;
    const attempts = opts.attempts ?? 3;
    for (let i = 1; ; i++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: this.authHeader(await this.token()),
            "Content-Type": "application/json",
            Accept: "application/json",
            ...this.extraHeaders(),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (e: any) {
        if (i >= attempts) throw new EbayApiError(`eBay API network error: ${e?.message ?? e}`, 0, null);
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
      if ((res.status === 429 || res.status >= 500) && i < attempts) {
        logger.warn(`${method} ${path} -> ${res.status}, retry ${i}`);
        await sleep(1500 * i);
        continue;
      }
      throw new EbayApiError(errorMessage(body, res.status), res.status, body);
    }
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }
  post<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("POST", path, { body: body ?? {}, query });
  }
  put<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("PUT", path, { body: body ?? {}, query });
  }
  delete<T = any>(path: string, query?: Query) {
    return this.request<T>("DELETE", path, { query });
  }
}

export class SellClient extends BaseClient {
  constructor(
    token: () => Promise<string>,
    public marketplaceId = "EBAY_US",
  ) {
    super(token);
  }
  protected authHeader(t: string) {
    return `Bearer ${t}`;
  }
  protected extraHeaders() {
    return { "X-EBAY-C-MARKETPLACE-ID": this.marketplaceId, "Accept-Language": "en-US", "Content-Language": "en-US" };
  }

  /**
   * Walk an offset/limit paged collection (most Sell APIs: `{ total, limit, offset, <key>: [...] }`).
   * Stops after `max` items so a sync can't run forever.
   */
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

export class PostOrderClient extends BaseClient {
  protected authHeader(t: string) {
    return `IAF ${t}`;
  }
  protected extraHeaders() {
    return { "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" };
  }
}

export interface StoreClients {
  trading: TradingClient;
  sell: SellClient;
  postOrder: PostOrderClient;
}

/** All API clients for one connected account (token refreshed with the scopes it granted). */
export function clientsFor(store: StoreDocument): StoreClients {
  const refresh = decrypt(store.auth.refreshTokenEnc);
  const token = () => userAccessToken(String(store._id), refresh, store.auth.scopes);
  return {
    trading: new TradingClient(token, store.siteId),
    sell: new SellClient(token, store.marketplaceId || "EBAY_US"),
    postOrder: new PostOrderClient(token),
  };
}
