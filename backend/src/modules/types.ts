/**
 * Account-management modules (Orders, Returns, Messages, ...). Each lives in its own folder
 * `src/modules/<key>/` and exports one `AccountModule` from `index.ts`. The registry (`modules/index.ts`)
 * mounts its router, runs its sync in the background and merges its sidebar counts - so a module never
 * needs to touch app.ts, the worker or the frontend nav.
 *
 * To build a module: put models, eBay calls, routes and sync in its folder, then set `ready: true`.
 */
import type { Router } from "express";
import type { StoreClients } from "../lib/ebay/sell";
import type { StoreDocument } from "../models/Store";

export const MODULE_KEYS = [
  "orders",
  "returns",
  "messages",
  "feedback",
  "finances",
  "analytics",
  "promotions",
  "inventory",
  "shipping",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Numbers for the sidebar badges and the all-accounts overview. null = not known (yet). */
export interface Counts {
  salesToday?: number | null;
  ordersToday?: number | null;
  awaitingShipment?: number | null;
  openReturns?: number | null;
  openCases?: number | null;
  unreadMessages?: number | null;
  negativeFeedback?: number | null;
  availableFunds?: number | null;
  currency?: string;
  lowStock?: number | null;
  activeCampaigns?: number | null;
  sellerLevel?: string | null;
}

export interface SyncContext {
  store: StoreDocument;
  clients: StoreClients;
  /** what the last successful run returned as `cursor` (e.g. a last-modified date) */
  cursor: any;
  lastSuccessAt: Date | null;
  log: (msg: string) => void;
}

export interface SyncResult {
  /** saved and handed back next run, for incremental syncs */
  cursor?: unknown;
  /** one line for the sync status list, e.g. "12 orders updated" */
  summary?: string;
}

export interface AccountModule {
  key: ModuleKey;
  label: string;
  /** false = not built yet: sidebar shows "Soon", no sync runs, the API answers 501 */
  ready: boolean;
  /** OAuth scopes the module needs; missing ones -> skipped with "reconnect the account" */
  scopes?: string[];
  /** mounted at /api/stores/:storeId/<key> (behind sign-in); create it with Router({ mergeParams: true }) */
  router?: Router;
  /** background refresh from eBay, run by account_sync jobs */
  sync?: (ctx: SyncContext) => Promise<SyncResult>;
  /** cheap counts from the local database for badges/overview */
  counts?: (store: StoreDocument) => Promise<Counts>;
}
