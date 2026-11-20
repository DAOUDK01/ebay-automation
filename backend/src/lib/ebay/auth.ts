import { env } from "../../config/env";

const SCOPE = (s = "") => `https://api.ebay.com/oauth/api_scope${s ? `/${s}` : ""}`;

/** Scopes accounts connected before full account management were granted. */
export const LEGACY_SCOPES = [SCOPE(), SCOPE("sell.inventory"), SCOPE("sell.account"), SCOPE("sell.analytics.readonly")];

/** Everything the app asks for when an account connects (or reconnects). */
export const USER_SCOPES = [
  ...LEGACY_SCOPES,
  SCOPE("sell.fulfillment"), // orders, tracking, refunds
  SCOPE("sell.finances"), // payouts, transactions, fees
  SCOPE("sell.marketing"), // promoted listings, markdowns
  SCOPE("commerce.identity.readonly"), // account details
];

/** Which features need which scope - drives the "reconnect to enable ..." banner. */
export const SCOPE_FEATURES: Record<string, string> = {
  [SCOPE("sell.fulfillment")]: "Orders & shipping",
  [SCOPE("sell.finances")]: "Finances & payouts",
  [SCOPE("sell.marketing")]: "Promotions",
  [SCOPE("commerce.identity.readonly")]: "Account details",
};

/** Scopes this app needs that the account hasn't granted yet (empty = all good). */
export const missingScopes = (granted: string[] | undefined) => USER_SCOPES.filter((s) => !(granted ?? LEGACY_SCOPES).includes(s));
const APP_SCOPES = ["https://api.ebay.com/oauth/api_scope"];

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

function assertConfigured() {
  if (!env.ebay.clientId || !env.ebay.clientSecret) {
    throw new Error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not set in backend/.env");
  }
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  assertConfigured();
  const basic = Buffer.from(`${env.ebay.clientId}:${env.ebay.clientSecret}`).toString("base64");
  const res = await fetch(`${env.ebay.apiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`eBay OAuth error ${res.status}: ${text}`);
  return JSON.parse(text) as TokenResponse;
}

export function consentUrl(state: string): string {
  assertConfigured();
  if (!env.ebay.ruName) throw new Error("EBAY_RUNAME is not set in backend/.env");
  const p = new URLSearchParams({
    client_id: env.ebay.clientId,
    redirect_uri: env.ebay.ruName,
    response_type: "code",
    scope: USER_SCOPES.join(" "),
    state,
  });
  return `${env.ebay.authBase}/oauth2/authorize?${p.toString()}`;
}

export async function exchangeCode(code: string) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: env.ebay.ruName });
  if (!t.refresh_token) throw new Error("eBay did not return a refresh token");
  return {
    accessToken: t.access_token,
    accessExpiresAt: Date.now() + t.expires_in * 1000,
    refreshToken: t.refresh_token,
    refreshExpiresAt: new Date(Date.now() + (t.refresh_token_expires_in ?? 47304000) * 1000),
  };
}

// in-memory access-token caches
const userTokenCache = new Map<string, { token: string; exp: number }>();
let appTokenCache: { token: string; exp: number } | null = null;

/**
 * Access token for a connected account. Refresh with the scopes THIS account granted - asking for more than
 * the refresh token carries makes eBay reject the request (accounts connected before new scopes were added).
 */
export async function userAccessToken(cacheKey: string, refreshToken: string, granted?: string[]): Promise<string> {
  const c = userTokenCache.get(cacheKey);
  if (c && Date.now() < c.exp - 120_000) return c.token;
  const scopes = granted?.length ? granted : LEGACY_SCOPES;
  let t: TokenResponse;
  try {
    t = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, scope: scopes.join(" ") });
  } catch (e: any) {
    // 400/401 from the token endpoint = the saved connection was revoked, expired or is invalid
    if (/OAuth error 40[01]/.test(String(e?.message))) {
      throw new Error(`eBay rejected this account's connection - reconnect it (Reconnect eBay on the store page). ${String(e.message).slice(0, 200)}`);
    }
    throw e;
  }
  userTokenCache.set(cacheKey, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

export function seedUserToken(cacheKey: string, token: string, exp: number) {
  userTokenCache.set(cacheKey, { token, exp });
}

export async function appAccessToken(): Promise<string> {
  if (appTokenCache && Date.now() < appTokenCache.exp - 120_000) return appTokenCache.token;
  const t = await tokenRequest({ grant_type: "client_credentials", scope: APP_SCOPES.join(" ") });
  appTokenCache = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
  return t.access_token;
}
