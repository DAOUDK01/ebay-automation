/**
 * Instant messages via eBay Platform Notifications (Trading API).
 *
 * Each connected account is subscribed (SetNotificationPreferences) to AskSellerQuestion and
 * MyMessagesM2MMessage. eBay then POSTs a SOAP message to /api/ebay/notifications the moment a buyer
 * writes. We treat it purely as a "check now" signal: nothing in the payload is trusted or stored - a
 * normal messages sync fetches the new messages from eBay. With EBAY_DEV_ID set, the payload's
 * signature is verified too; repeated notifications for one account are throttled.
 *
 * The eBay keyset may be shared with another app, so we never change its main ApplicationURL: we add
 * a named delivery URL (DeliveryURLDetails) and point only our users at it (DeliveryURLName).
 */
import { createHash } from "node:crypto";
import { Schema, model, type Types } from "mongoose";
import { env } from "../../config/env";
import { xmlEscape, type TradingClient } from "../../lib/ebay/trading";
import { logger } from "../../lib/logger";

export const NOTIFY_EVENTS = ["AskSellerQuestion", "MyMessagesM2MMessage"] as const;
export const DELIVERY_NAME = "listing_optimizer_messages";
/** at most one notification-triggered sync per account in this window (more are folded into it) */
export const THROTTLE_MS = 20_000;
/** eBay's timestamps must be this fresh for a signed notification to count */
const MAX_SKEW_MS = 10 * 60_000;

// ---------------------------------------------------------------- per-store subscription state

const notifySchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true, unique: true },
    enabledAt: { type: Date, default: null },
    url: { type: String, default: "" },
    error: { type: String, default: "" },
    lastAttemptAt: { type: Date, default: null },
    lastNotificationAt: { type: Date, default: null },
    lastEvent: { type: String, default: "" },
    notifications: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const MessageNotify = model("MessageNotify", notifySchema);

/** Where eBay should send notifications (must be public https). */
export function notificationUrl(): string {
  const base = env.publicApiUrl || `${env.frontendUrl.replace(/\/+$/, "")}/api`;
  return `${base}/ebay/notifications`;
}

// ---------------------------------------------------------------- subscribe

export function buildSubscribeXml(url: string) {
  return (
    `<ApplicationDeliveryPreferences>` +
    `<ApplicationEnable>Enable</ApplicationEnable>` +
    `<DeviceType>Platform</DeviceType>` +
    `<DeliveryURLDetails><DeliveryURLName>${DELIVERY_NAME}</DeliveryURLName><DeliveryURL>${xmlEscape(url)}</DeliveryURL><Status>Enable</Status></DeliveryURLDetails>` +
    `</ApplicationDeliveryPreferences>` +
    `<DeliveryURLName>${DELIVERY_NAME}</DeliveryURLName>` +
    `<UserDeliveryPreferenceArray>` +
    NOTIFY_EVENTS.map((e) => `<NotificationEnable><EventType>${e}</EventType><EventEnable>Enable</EventEnable></NotificationEnable>`).join("") +
    `</UserDeliveryPreferenceArray>`
  );
}

/** Subscribe one account. Never throws: the outcome is saved for the status shown in the app. */
export async function subscribe(storeId: Types.ObjectId, trading: Pick<TradingClient, "call">, url = notificationUrl()) {
  const now = new Date();
  if (!/^https:\/\//i.test(url)) {
    const error = "Instant messages need a public https address (set PUBLIC_API_URL / FRONTEND_URL)";
    await MessageNotify.updateOne({ storeId }, { $set: { error, lastAttemptAt: now, url } }, { upsert: true });
    return { ok: false, error };
  }
  try {
    await trading.call("SetNotificationPreferences", buildSubscribeXml(url), 1);
    await MessageNotify.updateOne({ storeId }, { $set: { enabledAt: now, url, error: "", lastAttemptAt: now } }, { upsert: true });
    return { ok: true, error: "" };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 400);
    logger.warn(`instant messages: subscribe failed for ${storeId}: ${error}`);
    await MessageNotify.updateOne({ storeId }, { $set: { error, lastAttemptAt: now, url } }, { upsert: true });
    return { ok: false, error };
  }
}

/** Subscribe if never done, if the address changed, or retry a failure once a day. */
export async function ensureSubscribed(storeId: Types.ObjectId, trading: Pick<TradingClient, "call">) {
  const url = notificationUrl();
  const st = await MessageNotify.findOne({ storeId }).lean();
  const fresh = st?.enabledAt && st.url === url && !st.error;
  const retryDue = !st?.lastAttemptAt || Date.now() - new Date(st.lastAttemptAt).getTime() > 24 * 3600_000;
  if (fresh || (st?.error && !retryDue)) return null;
  return subscribe(storeId, trading, url);
}

// ---------------------------------------------------------------- receive

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(xml);
  return m ? m[1].trim() : "";
};

export interface ParsedNotification {
  event: string;
  recipient: string;
  timestamp: string;
  signature: string;
}

export function parseNotification(xml: string): ParsedNotification {
  return {
    event: tag(xml, "NotificationEventName"),
    recipient: tag(xml, "RecipientUserID"),
    timestamp: tag(xml, "Timestamp"),
    signature: tag(xml, "NotificationSignature"),
  };
}

/** eBay's signature: Base64(MD5(Timestamp + DevID + AppID + CertID)). */
export const expectedSignature = (timestamp: string, devId: string, appId: string, certId: string) =>
  createHash("md5").update(`${timestamp}${devId}${appId}${certId}`).digest("base64");

export type Verdict = "valid" | "invalid" | "unverified";

/** "unverified" = no Dev ID configured, so we can't check (the notification is only a hint anyway). */
export function verifyNotification(n: ParsedNotification, keys = { devId: env.ebay.devId, appId: env.ebay.clientId, certId: env.ebay.clientSecret }, now = Date.now()): Verdict {
  if (!keys.devId || !keys.appId || !keys.certId) return "unverified";
  if (!n.signature || !n.timestamp) return "invalid";
  const ts = Date.parse(n.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return "invalid";
  return n.signature === expectedSignature(n.timestamp, keys.devId, keys.appId, keys.certId) ? "valid" : "invalid";
}

/** Throttled "sync this account's messages now": a burst of notifications becomes one or two syncs. */
export function makeTrigger(run: (storeId: string) => Promise<unknown>, throttleMs = THROTTLE_MS) {
  const state = new Map<string, { running: boolean; again: boolean; last: number }>();
  const fire = async (storeId: string): Promise<void> => {
    const s = state.get(storeId) ?? { running: false, again: false, last: 0 };
    state.set(storeId, s);
    if (s.running) {
      s.again = true;
      return;
    }
    const wait = s.last + throttleMs - Date.now();
    if (wait > 0) {
      if (!s.again) {
        s.again = true;
        setTimeout(() => {
          s.again = false;
          void fire(storeId);
        }, wait).unref?.();
      }
      return;
    }
    s.running = true;
    s.last = Date.now();
    try {
      await run(storeId);
    } catch (e: any) {
      logger.warn(`instant messages: sync for ${storeId} failed: ${e?.message ?? e}`);
    } finally {
      s.running = false;
      if (s.again) {
        s.again = false;
        setTimeout(() => void fire(storeId), Math.max(0, s.last + throttleMs - Date.now())).unref?.();
      }
    }
  };
  return fire;
}
