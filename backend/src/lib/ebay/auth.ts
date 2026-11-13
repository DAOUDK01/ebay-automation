import { env } from "../../config/env";

export const USER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
];
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

export async function userAccessToken(cacheKey: string, refreshToken: string): Promise<string> {
  const c = userTokenCache.get(cacheKey);
  if (c && Date.now() < c.exp - 120_000) return c.token;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, scope: USER_SCOPES.join(" ") });
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
