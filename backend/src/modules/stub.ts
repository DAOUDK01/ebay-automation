import { Router } from "express";
import type { AccountModule, ModuleKey } from "./types";

/** Placeholder for a module that isn't built yet: API answers 501, no sync, sidebar shows "Soon". */
export function stubModule(key: ModuleKey, label: string, scopes: string[] = []): AccountModule {
  const router = Router({ mergeParams: true });
  router.use((_req, res) => {
    res.status(501).json({ error: `${label} is coming soon` });
  });
  return { key, label, ready: false, scopes, router };
}
