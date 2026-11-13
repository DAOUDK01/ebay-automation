# Listing Optimizer â€” AI eBay listing optimization

A web app that works through an eBay store **in batches**. For each listing it:

- pulls the full listing
- checks the category's required item specifics
- compares prices against competing listings
- asks Claude for a better title, missing specifics, a price and fitment

Every suggestion then goes through hard **safety rules in code**. You review the result, or let it run automatically. Then it **pushes the batch to eBay** and moves on to the next one.

```
frontend/   Next.js 15 (App Router, Tailwind, SWR)  :3100   â€“ UI, proxies /api/* to the backend
backend/    Express 5 + Mongoose (TypeScript)        :4100   â€“ REST API
            worker (same codebase, separate process)          â€“ runs batches, sync and push jobs
MongoDB                                                        â€“ users, stores, listings, batches, changes, jobs, usage
```

## How it works

1. **Connect eBay.** You sign in on eBay's own consent page (OAuth). The refresh token is stored **AES-256-GCM encrypted**.
2. **Sync.** All active listings are imported through the Trading API (`GetMyeBaySelling`). It re-syncs every `resyncHours`.
3. **Batch.** The worker picks the next N listings: never-optimized first, then the weakest (fewest sales or watchers), skipping anything touched within `cooldownDays`. For each listing it:
   - reads the full listing (`GetItem`)
   - gets the category aspects (Taxonomy API)
   - finds competitors (Browse API), searching by part number first, then by title
   - asks Claude, getting structured JSON back
4. **Safety rules** in [backend/src/lib/guardrails.ts](backend/src/lib/guardrails.ts):
   - **Title:** 80 characters or less, no spam words, never much shorter than before.
   - **Price moves:** at most Â±`maxChangePct` per edit.
   - **Price drops:** only with your cost on file, and never below cost Ã— (1 + margin) Ã· (1 âˆ’ fees).
   - **Specifics:** only aspects that exist in the category, and only eBay's allowed values for selection-only aspects. By default they're only added, never overwritten.
   - **Fitment:** report-only until you turn it on.
5. **Review or auto.**
   - **Review mode:** approve, edit or reject each change in the UI, then click *Push approved*.
   - **Auto mode:** changes are pushed when the batch finishes.
6. **Push** with `ReviseFixedPriceItem`. Every change keeps a before snapshot, so it can be **reverted** with one click.
7. The worker waits `gapBetweenBatchesMin`, only inside `activeHours`, then starts the next batch. It **stops by itself at the monthly Claude budget**.

## Setup

Requirements: Node 20+, and MongoDB (local, Docker, or Atlas).

```bash
npm run install:all
npm run db:up                         # or point MONGODB_URI at Atlas
copy backend\.env.example backend\.env
copy frontend\.env.example frontend\.env.local
```

Fill in `backend/.env`:

| Variable | Where to get it |
|---|---|
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` â€” keep it safe; losing it means reconnecting every store |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | developer.ebay.com â†’ Application Keys (Production) |
| `EBAY_RUNAME` | developer.ebay.com â†’ User Tokens â†’ *Get a Token from eBay via Your Application* â†’ your RuName |
| `ANTHROPIC_API_KEY` | console.anthropic.com |

**RuName settings:** set the *Auth accepted URL* to `https://<your-domain>/api/ebay/callback`. eBay requires https.

On localhost, eBay redirects to a URL that won't load. In that case, copy the address from the browser bar and use **Stores â†’ Paste eBay code** in the app.

```bash
npm run dev        # starts the API (:4100), the worker and the web app (:3100)
```

Open http://localhost:3100, create an account, and click **Connect eBay account**. Then on the store's Overview tab:

1. Click **Sync listings**.
2. Run a **5-listing batch**.
3. Review it.
4. Push it.

Once you trust the results, switch on the **Automatic runner**. Switch to **auto mode** in Settings only after several good batches.

**Demo data (local only):** to explore the UI without connecting eBay, run `npm --prefix backend run seed:demo`. It creates a demo store with listings and a batch to review, and prints the demo login.

## Adding a feature to the sidebar

Every section of the app is registered in [frontend/src/lib/nav.ts](frontend/src/lib/nav.ts).
1. Build the page at `frontend/src/app/stores/[id]/<path>/page.tsx`.
2. Find its entry in `STORE_NAV` and remove `soon: true`, or add a new entry.

The sidebar, breadcrumb and page header pick it up automatically.

## Tests

```bash
npm test
```

- **Unit tests:** safety rules, XML parsing and building, active hours, settings merge.
- **End-to-end tests:** real MongoDB (in-memory) plus the real Express app, with fake eBay and Claude. They cover auth, sync, a review batch, edit/approve/reject, push, revert, cooldown, auto mode, settings validation, cost import, and isolation between users.

## Costs

| Model | Approx. per listing | ~Listings per $90 |
|---|---|---|
| Claude Opus 5.5 (default, medium effort) | $0.04â€“0.08 | 1,200â€“2,000 |
| Claude Sonnet 5.5 | $0.02â€“0.04 | 2,500â€“4,000 |

These are estimates. Actual spend is tracked per store and month on the Overview tab.

Opus 5.5 and Sonnet 5.5 calls also enable Anthropic's server-side refusal fallback (`fallbacks: "default"`). If one model declines a listing, another model completes it in the same request.

## Deploying

- **Frontend:** Vercel or any Node host (`npm run build && npm start`). Set `BACKEND_URL`.
- **API and worker:** any VPS, Railway or Render. The worker is a long-running process, so it **cannot run on serverless functions**. Run `npm run start` and `npm run start:worker` (e.g. with pm2). You can run several worker copies; jobs are locked so they don't collide.
- **Database:** MongoDB Atlas.
- **Production settings:** set `NODE_ENV=production` (secure cookies) and `FRONTEND_URL` to your domain.

## Extending

- **New job types:** add to `JOB_TYPES` in `backend/src/models/Job.ts` and handle them in `runJob` (`backend/src/worker.ts`).
- **New optimization modules** (descriptions, images, promoted listings, best offer, â€¦):
  1. Add a setting under `modules` in `models/Store.ts` and `routes/settingsSchema.ts`.
  2. Add a check in `lib/guardrails.ts`.
  3. Wire it into `buildChanges` in `services/pipeline.ts`.
  4. Add the field to the `ReviseFixedPriceItem` builder in `lib/ebay/trading.ts`.
- **Prompt and output schema:** `backend/src/lib/claude.ts`.
- **Other ideas:** measuring impact with the Sell Analytics API (traffic before/after each change), shipping-policy optimization, billing for multi-tenant SaaS.

## Not handled yet

- **Prices on multi-variation listings and auctions:** skipped.
- **Shipping:** advice only. It's shown in the review details, not changed.
- **Reverting fitment:** compatibility rows that were added are not removed when you revert.
