/** Background refresh of every ready account module for one store, and the merged sidebar counts. */
import { missingScopes } from "../lib/ebay/auth";
import { clientsFor, type StoreClients } from "../lib/ebay/sell";
import { logger } from "../lib/logger";
import type { StoreDocument } from "../models/Store";
import { SyncState } from "../models/SyncState";
import { MODULES } from "../modules";
import type { AccountModule, Counts, ModuleKey } from "../modules/types";

/** Modules that have a sync and can run for this account (built, and scopes granted). */
export function syncableModules(store: StoreDocument, only?: ModuleKey[], modules: AccountModule[] = MODULES) {
  const missing = new Set(missingScopes(store.auth?.scopes));
  return modules.filter((m) => m.ready && m.sync && (!only?.length || only.includes(m.key))).map((m) => ({
    module: m,
    missing: (m.scopes ?? []).filter((s) => missing.has(s)),
  }));
}

export interface ModuleRun {
  module: ModuleKey;
  ok: boolean;
  summary: string;
}

/** Run the syncs (one module failing doesn't stop the others). `clients` is injectable for tests. */
export async function runAccountSync(
  store: StoreDocument,
  only?: ModuleKey[],
  clients?: StoreClients,
  modules: AccountModule[] = MODULES,
): Promise<ModuleRun[]> {
  const c = clients ?? clientsFor(store);
  const runs: ModuleRun[] = [];
  for (const { module: m, missing } of syncableModules(store, only, modules)) {
    const now = new Date();
    const state = await SyncState.findOne({ storeId: store._id, module: m.key }).lean();
    if (missing.length) {
      const msg = "Reconnect this eBay account to allow " + m.label;
      await SyncState.updateOne({ storeId: store._id, module: m.key }, { $set: { lastRunAt: now, error: msg } }, { upsert: true });
      runs.push({ module: m.key, ok: false, summary: msg });
      continue;
    }
    try {
      const r = await m.sync!({
        store,
        clients: c,
        cursor: state?.cursor ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        log: (msg) => logger.info(`[${store.name}] ${m.key}: ${msg}`),
      });
      await SyncState.updateOne(
        { storeId: store._id, module: m.key },
        {
          $set: {
            lastRunAt: now,
            lastSuccessAt: now,
            summary: r.summary ?? "",
            error: "",
            ...(r.cursor !== undefined ? { cursor: r.cursor } : {}),
          },
        },
        { upsert: true },
      );
      runs.push({ module: m.key, ok: true, summary: r.summary ?? "" });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 500);
      logger.error(`[${store.name}] ${m.key} sync failed`, e);
      await SyncState.updateOne({ storeId: store._id, module: m.key }, { $set: { lastRunAt: now, error: msg } }, { upsert: true });
      runs.push({ module: m.key, ok: false, summary: msg });
    }
  }
  return runs;
}

/** Merge every ready module's counts (a failing module just contributes nothing). */
export async function countsFor(store: StoreDocument, modules: AccountModule[] = MODULES): Promise<Counts> {
  const parts = await Promise.all(
    modules
      .filter((m) => m.ready && m.counts)
      .map((m) =>
        m.counts!(store).catch((e) => {
          logger.warn(`[${store.name}] ${m.key} counts failed: ${e?.message ?? e}`);
          return {} as Counts;
        }),
      ),
  );
  return Object.assign({}, ...parts);
}
