"use client";
import { ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { api, dateTime, fetcher, money } from "@/lib/api";
import { ACTION_LABEL, DUE_ACTION_LABEL, humanize, KIND_LABEL, urgency, type CaseEvent, type ReturnDetailResponse } from "@/lib/returns";
import { ActionDialog } from "./ActionDialog";
import { DeadlineBadge } from "./DeadlineBadge";

const DANGER = new Set(["decline", "reject", "refund"]);

export function ReturnDetail({ storeId, kind, ebayId, onChanged }: { storeId: string; kind: string; ebayId: string; onChanged: () => void }) {
  const key = `/stores/${storeId}/returns/${kind}/${encodeURIComponent(ebayId)}`;
  const { data, error, mutate } = useSWR<ReturnDetailResponse>(key, fetcher);
  const [action, setAction] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Spinner />
      </div>
    );
  const c = data.item;
  const u = urgency(c.respondBy);
  const events: CaseEvent[] = [
    ...(c.openedAt ? [{ at: c.openedAt, actor: "BUYER", action: `${KIND_LABEL[c.kind]} opened`, text: [humanize(c.reason), c.comments].filter(Boolean).join(" — ") }] : []),
    ...(c.timeline ?? []),
    ...(c.appActions ?? []),
  ].sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());

  async function refresh() {
    setRefreshing(true);
    try {
      await api(`${key}/refresh`, { method: "POST" });
      await mutate();
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {KIND_LABEL[c.kind]} {c.ebayId}
            <Badge color={c.open ? "yellow" : "gray"}>{humanize(c.status) || (c.open ? "Open" : "Closed")}</Badge>
          </span>
        }
        actions={
          <Button size="sm" variant="ghost" onClick={refresh} loading={refreshing} title="Reload from eBay">
            {!refreshing && <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        }
      >
        {c.open && c.respondBy && (
          <div
            className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${
              u === "overdue" || u === "today" ? "border-rose-200 bg-rose-50" : u === "soon" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"
            }`}
          >
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">eBay deadline</div>
              <div className="text-sm font-medium text-slate-900">
                {DUE_ACTION_LABEL[c.dueAction] ?? (humanize(c.dueAction) || "Respond")} by {dateTime(c.respondBy)}
              </div>
              {u === "overdue" && <div className="text-xs text-rose-700">Past the deadline - eBay may step in and decide for the buyer.</div>}
            </div>
            <DeadlineBadge respondBy={c.respondBy} large />
          </div>
        )}
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Field label="Buyer">{c.buyer || "—"}</Field>
          <Field label="Type">{humanize(c.type) || "—"}</Field>
          <Field label="Item">
            {c.itemId ? (
              <Link href={`/stores/${storeId}/listings/${c.itemId}`} className="text-brand-700 hover:underline">
                {c.itemTitle || c.itemId}
              </Link>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Order">{c.orderId || "—"}</Field>
          <Field label="Reason">{humanize(c.reason) || "—"}</Field>
          <Field label={c.kind === "case" ? "Claim" : "Refund requested"}>{c.amount ? money(c.amount.value, c.amount.currency) : "—"}</Field>
          {c.refunded && <Field label="Refunded">{money(c.refunded.value, c.refunded.currency)}</Field>}
          <Field label="Opened">{dateTime(c.openedAt)}</Field>
          {c.closedAt && <Field label="Closed">{dateTime(c.closedAt)}</Field>}
        </dl>
        {c.comments && (
          <blockquote className="mt-4 rounded-md border-l-4 border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">“{c.comments}”</blockquote>
        )}
        {data.actions.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            {data.actions.map((a) => (
              <Button key={a} size="sm" variant={a === "approve" ? "success" : DANGER.has(a) ? "danger" : "secondary"} onClick={() => setAction(a)}>
                {c.kind === "case" && a === "refund" ? "Refund in full" : ACTION_LABEL[a] ?? a}
              </Button>
            ))}
          </div>
        )}
        {c.itemId && (
          <a
            className="mt-3 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
            href={`https://www.ebay.com/itm/${encodeURIComponent(c.itemId)}`}
            target="_blank"
            rel="noreferrer"
          >
            View the item on eBay <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </Card>

      <Card title="Timeline">
        {events.length ? (
          <ol className="relative space-y-4 border-l border-slate-200 pl-5">
            {events.map((e, i) => (
              <li key={i} className="relative">
                <span className={`absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ${e.actor === "APP" || e.actor === "SELLER" ? "bg-brand-600" : e.actor === "BUYER" ? "bg-amber-500" : "bg-slate-400"}`} />
                <div className="text-xs text-slate-500">
                  {dateTime(e.at)} · {e.actor === "APP" ? "You (from this app)" : humanize(e.actor)}
                </div>
                <div className="text-sm font-medium text-slate-800">{e.actor === "APP" ? e.text : humanize(e.action)}</div>
                {e.actor !== "APP" && e.text && <div className="text-sm text-slate-600">{e.text}</div>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-slate-500">No history yet - use Refresh to load it from eBay.</p>
        )}
      </Card>

      {data.related.length > 0 && (
        <Card title="Same order">
          <ul className="space-y-1 text-sm">
            {data.related.map((r) => (
              <li key={r._id}>
                {KIND_LABEL[r.kind]} {r.ebayId} · {humanize(r.status)} {r.open && <Badge color="yellow">open</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ActionDialog
        storeId={storeId}
        item={c}
        action={action}
        onClose={() => setAction(null)}
        onDone={() => {
          mutate();
          onChanged();
        }}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="truncate text-slate-800">{children}</dd>
    </div>
  );
}
