/**
 * /api/stores/:storeId/returns - inbox, detail and seller actions.
 * Every action that changes something on eBay needs `confirm: true` in the body: the UI only sends it
 * from a confirm dialog after the user clicks, and nothing here runs from a background job.
 */
import { Router } from "express";
import { z } from "zod";
import { clientsFor, type StoreClients } from "../../lib/ebay/sell";
import { loadStore } from "../../middleware/auth";
import { HttpError, parseBody } from "../../middleware/error";
import type { StoreDocument } from "../../models/Store";
import { actions, type PostOrderRequest } from "./ebay";
import { POST_ORDER_KINDS, PostOrderCase, type PostOrderKind } from "./model";
import { refreshDetail } from "./sync";

/** Swappable in tests (fake eBay clients). */
export const deps = {
  clients: (store: StoreDocument): Pick<StoreClients, "postOrder"> => clientsFor(store),
};

const DUE_SOON_HOURS = 48;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const router = Router({ mergeParams: true });

function kindParam(v: unknown): PostOrderKind {
  const k = String(v ?? "");
  if (!(POST_ORDER_KINDS as readonly string[]).includes(k)) throw new HttpError(404, "Unknown type");
  return k as PostOrderKind;
}

/** Inbox: ?kind=return|cancellation|case &state=open|closed|all &due=soon|overdue &q= &page= */
router.get("/", async (req, res) => {
  const store = await loadStore(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
  const now = new Date();
  const soon = new Date(now.getTime() + DUE_SOON_HOURS * 3600_000);
  const filter: Record<string, unknown> = { storeId: store._id };
  if (req.query.kind) filter.kind = kindParam(req.query.kind);
  const state = String(req.query.state ?? "open");
  if (state === "open") filter.open = true;
  if (state === "closed") filter.open = false;
  if (req.query.due === "soon") Object.assign(filter, { open: true, respondBy: { $ne: null, $lte: soon } });
  if (req.query.due === "overdue") Object.assign(filter, { open: true, respondBy: { $ne: null, $lt: now } });
  const q = String(req.query.q ?? "").trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ buyer: rx }, { itemTitle: rx }, { itemId: q }, { orderId: q }, { ebayId: q }];
  }
  // open: most urgent deadline first (no deadline last); closed: newest first
  const sort: Record<string, 1 | -1> = state === "open" || req.query.due ? { open: -1, respondBy: 1, openedAt: -1 } : { openedAt: -1 };
  const [rows, total, summary] = await Promise.all([
    PostOrderCase.aggregate([
      { $match: filter },
      // nulls sort first in Mongo; push rows without a deadline to the end
      { $addFields: { _noDue: { $cond: [{ $eq: [{ $ifNull: ["$respondBy", null] }, null] }, 1, 0] } } },
      { $sort: { ...(sort.respondBy ? { _noDue: 1 } : {}), ...sort } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      { $project: { raw: 0, detailRaw: 0, timeline: 0, _noDue: 0 } },
    ]),
    PostOrderCase.countDocuments(filter),
    summaryFor(store, now, soon),
  ]);
  res.json({ items: rows, total, page, pageSize, summary });
});

async function summaryFor(store: StoreDocument, now: Date, soon: Date) {
  const base = { storeId: store._id, open: true };
  const [byKind, dueSoon, overdue] = await Promise.all([
    PostOrderCase.aggregate([{ $match: base }, { $group: { _id: "$kind", n: { $sum: 1 } } }]),
    PostOrderCase.countDocuments({ ...base, respondBy: { $ne: null, $lte: soon } }),
    PostOrderCase.countDocuments({ ...base, respondBy: { $ne: null, $lt: now } }),
  ]);
  const open = Object.fromEntries(POST_ORDER_KINDS.map((k) => [k, byKind.find((x) => x._id === k)?.n ?? 0]));
  return { open, dueSoon, overdue };
}

async function findCase(store: StoreDocument, kind: PostOrderKind, ebayId: string) {
  const doc = await PostOrderCase.findOne({ storeId: store._id, kind, ebayId });
  if (!doc) throw new HttpError(404, "Not found");
  return doc;
}

router.get("/:kind/:ebayId", async (req, res) => {
  const store = await loadStore(req);
  const doc = await findCase(store, kindParam(req.params.kind), String(req.params.ebayId));
  const related = doc.orderId
    ? await PostOrderCase.find({ storeId: store._id, orderId: doc.orderId, _id: { $ne: doc._id } }).select("kind ebayId status open openedAt").lean()
    : [];
  res.json({ item: doc.toObject(), related, actions: availableActions(doc) });
});

/** Re-read one row (with its history) from eBay. */
router.post("/:kind/:ebayId/refresh", async (req, res) => {
  const store = await loadStore(req);
  const kind = kindParam(req.params.kind);
  const ebayId = String(req.params.ebayId);
  await findCase(store, kind, ebayId);
  try {
    await refreshDetail(store._id, deps.clients(store).postOrder, kind, ebayId);
  } catch (e: any) {
    throw new HttpError(502, `Couldn't load it from eBay: ${e?.message ?? e}`);
  }
  res.json({ item: (await findCase(store, kind, ebayId)).toObject() });
});

const note = z.string().trim().max(1000).optional();
const ACTION_SCHEMAS = {
  return: {
    approve: z.object({ note }),
    decline: z.object({ note: z.string({ error: "Tell the buyer why" }).trim().min(1, "Tell the buyer why").max(1000) }),
    refund: z.object({ amount: z.number().positive(), currency: z.string().length(3).optional(), note }),
    mark_received: z.object({ note }),
    message: z.object({ text: z.string().trim().min(1).max(2000) }),
  },
  cancellation: {
    approve: z.object({}),
    reject: z.object({ trackingNumber: z.string().trim().max(60).optional(), shippedDate: z.string().optional() }),
  },
  case: {
    tracking: z.object({ carrier: z.string().trim().min(1).max(60), trackingNumber: z.string().trim().min(1).max(60), shippedDate: z.string().optional() }),
    refund: z.object({ note }),
  },
} as const;

/** Which actions make sense right now (the UI shows only these). */
export function availableActions(doc: { kind: string; open: boolean; status: string }): string[] {
  if (!doc.open) return doc.kind === "return" ? ["message"] : [];
  if (doc.kind === "cancellation") return ["approve", "reject"];
  if (doc.kind === "case") return ["tracking", "refund"];
  const st = doc.status.toUpperCase();
  const out: string[] = [];
  if (/REQUESTED|PENDING|WAITING_FOR_RMA/.test(st) && !/REFUND/.test(st)) out.push("approve", "decline");
  if (/SHIPPED|DELIVERED|ITEM_READY_TO_SHIP|LABEL|ACCEPTED|ESCALATED/.test(st)) out.push("mark_received");
  out.push("refund", "message");
  return [...new Set(out)];
}

/** Pure: validated body -> the Post-Order request. Exported for tests. */
export function buildAction(kind: PostOrderKind, action: string, id: string, body: any, currency = "USD"): PostOrderRequest {
  const schema = (ACTION_SCHEMAS as any)[kind]?.[action];
  if (!schema) throw new HttpError(400, `Can't ${action.replace("_", " ")} a ${kind}`);
  const b = parseBody(schema, body);
  if (kind === "return") {
    if (action === "approve") return actions.approveReturn(id, b.note);
    if (action === "decline") return actions.declineReturn(id, b.note);
    if (action === "refund") return actions.refundReturn(id, { value: b.amount, currency: b.currency ?? currency }, b.note);
    if (action === "mark_received") return actions.markReturnReceived(id, b.note);
    return actions.messageReturn(id, b.text);
  }
  if (kind === "cancellation") return action === "approve" ? actions.approveCancellation(id) : actions.rejectCancellation(id, b);
  return action === "tracking" ? actions.caseShipment(id, b.carrier, b.trackingNumber, b.shippedDate) : actions.caseRefund(id, b.note);
}

router.post("/:kind/:ebayId/actions/:action", async (req, res) => {
  const store = await loadStore(req);
  const kind = kindParam(req.params.kind);
  const action = String(req.params.action);
  const doc = await findCase(store, kind, String(req.params.ebayId));
  if (req.body?.confirm !== true) throw new HttpError(400, "Please confirm this action");
  const { confirm: _c, ...body } = req.body ?? {};
  const request = buildAction(kind, action, doc.ebayId, body, doc.amount?.currency ?? "USD");
  if (kind === "return" && action === "refund" && doc.amount?.value && body.amount > doc.amount.value + 0.005) {
    throw new HttpError(400, `The refund can't be more than the ${doc.amount.currency} ${doc.amount.value.toFixed(2)} the buyer paid`);
  }
  const client = deps.clients(store).postOrder;
  let response: unknown;
  try {
    response = await client.post(request.path, request.body);
  } catch (e: any) {
    throw new HttpError(502, `eBay didn't accept it: ${e?.message ?? e}`);
  }
  await PostOrderCase.updateOne({ _id: doc._id }, { $push: { appActions: { at: new Date(), actor: "APP", action, text: request.label } } });
  // show eBay's new status straight away (best effort - the next sync catches up anyway)
  try {
    await refreshDetail(store._id, client, kind, doc.ebayId);
  } catch {
    /* ignore */
  }
  res.json({ ok: true, response: response ?? null, item: (await findCase(store, kind, doc.ebayId)).toObject() });
});

export default router;
