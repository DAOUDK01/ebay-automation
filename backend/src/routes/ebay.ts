/** Connect an eBay seller account via OAuth (user consent). */
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import { encrypt } from "../lib/crypto";
import { consentUrl, exchangeCode, seedUserToken, USER_SCOPES } from "../lib/ebay/auth";
import { TradingClient } from "../lib/ebay/trading";
import { logger } from "../lib/logger";
import { requireAuth } from "../middleware/auth";
import { HttpError, parseBody } from "../middleware/error";
import { DEFAULT_SETTINGS, Store } from "../models/Store";

const router = Router();

async function connectStore(userId: string, code: string) {
  const tokens = await exchangeCode(code);
  const ebayUserId = await new TradingClient(async () => tokens.accessToken, 0).getUserId();
  if (!ebayUserId) throw new Error("Could not read the eBay username for this account");
  const store = await Store.findOneAndUpdate(
    { userId, ebayUserId },
    {
      $set: {
        "auth.refreshTokenEnc": encrypt(tokens.refreshToken),
        "auth.refreshTokenExpiresAt": tokens.refreshExpiresAt,
        "auth.scopes": USER_SCOPES,
      },
      $setOnInsert: {
        name: ebayUserId,
        settings: { ...structuredClone(DEFAULT_SETTINGS), excludeSeller: ebayUserId },
        runner: { enabled: false, lastError: "" },
      },
    },
    { upsert: true, new: true },
  );
  seedUserToken(String(store!._id), tokens.accessToken, tokens.accessExpiresAt);
  logger.info(`eBay account ${ebayUserId} connected for user ${userId}`);
  return store!;
}

/** Step 1: frontend asks for the eBay consent URL and redirects the browser there. */
router.get("/connect-url", requireAuth, (req, res) => {
  const state = jwt.sign({ uid: req.userId }, env.jwtSecret, { expiresIn: "20m" });
  res.json({ url: consentUrl(state) });
});

/** Step 2 (automatic): eBay redirects here (set as the RuName "Auth accepted URL"). */
router.get("/callback", async (req, res) => {
  const fail = (msg: string) => res.redirect(`${env.frontendUrl}/stores?ebayError=${encodeURIComponent(msg)}`);
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code) return fail("eBay did not return an authorization code (consent declined?)");
  let uid: string;
  try {
    uid = (jwt.verify(state, env.jwtSecret) as { uid: string }).uid;
  } catch {
    return fail("Connection link expired - please try again");
  }
  try {
    const store = await connectStore(uid, code);
    res.redirect(`${env.frontendUrl}/stores/${store._id}?connected=1`);
  } catch (e: any) {
    logger.error("eBay connect failed", e);
    fail(e?.message ?? "eBay connection failed");
  }
});

/** Step 2 (manual fallback): paste the URL eBay redirected to (useful on localhost without https). */
router.post("/exchange", requireAuth, async (req, res) => {
  const { redirectUrl } = parseBody(z.object({ redirectUrl: z.string().min(5) }), req.body);
  let code = redirectUrl.trim();
  try {
    const u = new URL(redirectUrl);
    code = u.searchParams.get("code") ?? code;
  } catch {
    /* raw code pasted */
  }
  if (!code) throw new HttpError(400, "No code found in that URL");
  const store = await connectStore(req.userId!, decodeURIComponent(code));
  res.json({ store: { id: String(store._id), name: store.name, ebayUserId: store.ebayUserId } });
});

export default router;
