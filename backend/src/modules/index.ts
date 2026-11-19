/** Registry of account-management modules. Each module only edits its own folder. */
import type { Express } from "express";
import { requireAuth } from "../middleware/auth";
import analytics from "./analytics";
import feedback from "./feedback";
import finances from "./finances";
import inventory from "./inventory";
import messages from "./messages";
import orders from "./orders";
import promotions from "./promotions";
import returns from "./returns";
import shipping from "./shipping";
import type { AccountModule, ModuleKey } from "./types";

export const MODULES: AccountModule[] = [orders, returns, messages, feedback, finances, analytics, promotions, inventory, shipping];

export const getModule = (key: ModuleKey) => MODULES.find((m) => m.key === key);

/** Mount every module's API at /api/stores/:storeId/<key>, plus GET /api/modules for the sidebar. */
export function mountModules(app: Express) {
  app.get("/api/modules", requireAuth, (_req, res) => {
    res.json({ modules: MODULES.map((m) => ({ key: m.key, label: m.label, ready: m.ready })) });
  });
  for (const m of MODULES) if (m.router) app.use(`/api/stores/:storeId/${m.key}`, requireAuth, m.router);
}
