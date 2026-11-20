"use client";
import { ExternalLink, MailOpen, Mail } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { DeadlineBadge } from "@/components/returns/DeadlineBadge";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Spinner, cx } from "@/components/ui";
import { api, dateTime, fetcher, money } from "@/lib/api";
import { ebayItemUrl, type ThreadDetailResponse } from "@/lib/messages";
import { humanize } from "@/lib/returns";
import { ReplyBox } from "./ReplyBox";

export function ThreadView({ storeId, threadId, onChanged }: { storeId: string; threadId: string; onChanged: () => void }) {
  const key = `/stores/${storeId}/messages/threads/${threadId}`;
  const { data, error, mutate } = useSWR<ThreadDetailResponse>(key, fetcher);
  const bottom = useRef<HTMLDivElement>(null);
  const markedFor = useRef("");

  async function setRead(read: boolean) {
    try {
      const r = await api<{ warning: string }>(`${key}/read`, { body: { read } });
      if (r.warning) toast.info(r.warning);
      await mutate();
      onChanged();
      globalMutate(`/stores/${storeId}/counts`);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  // opening an unread conversation marks it read (once per open)
  useEffect(() => {
    if (data && data.thread.unread > 0 && markedFor.current !== threadId) {
      markedFor.current = threadId;
      setRead(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, threadId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [data?.messages.length]);

  if (error) return <Alert>{error.message}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Spinner />
      </div>
    );
  const { thread, messages, listing, cases } = data;

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">{thread.buyer}</div>
          <div className="truncate text-xs text-slate-500">{thread.subject}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setRead(thread.unread === 0 ? false : true)}>
          {thread.unread === 0 ? <Mail className="h-3.5 w-3.5" /> : <MailOpen className="h-3.5 w-3.5" />}
          {thread.unread === 0 ? "Mark unread" : "Mark read"}
        </Button>
      </header>

      {(thread.itemId || cases.length > 0) && (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50 px-5 py-2.5 text-sm">
          {listing?.imageUrl && <img src={listing.imageUrl} alt="" className="h-10 w-10 rounded object-cover" />}
          {thread.itemId && (
            <div className="min-w-0 flex-1">
              <Link href={`/stores/${storeId}/listings/${thread.itemId}`} className="block truncate font-medium text-brand-700 hover:underline">
                {listing?.title || thread.itemTitle || `Item ${thread.itemId}`}
              </Link>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                {listing?.price !== undefined && <span>{money(listing.price)}</span>}
                <a href={ebayItemUrl(thread.itemId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-slate-800">
                  #{thread.itemId} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}
          {cases.map((c) => (
            <Link key={c._id} href={`/stores/${storeId}/returns`} className="inline-flex items-center gap-1.5">
              <Badge color={c.open ? "yellow" : "gray"}>
                {humanize(c.kind)}: {humanize(c.status)}
              </Badge>
              {c.open && <DeadlineBadge respondBy={c.respondBy} />}
            </Link>
          ))}
        </div>
      )}

      <div className="max-h-[55vh] space-y-3 overflow-y-auto px-5 py-4">
        {messages.map((m) => (
          <div key={m._id} className={cx("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
            <div
              className={cx(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-sm",
                m.direction === "out" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-slate-200 bg-white text-slate-800",
              )}
            >
              <div className="whitespace-pre-wrap break-words">{m.body || <em className="opacity-70">{m.subject || "(no text yet - it loads on the next sync)"}</em>}</div>
              <div className={cx("mt-1 text-[11px]", m.direction === "out" ? "text-white/70" : "text-slate-400")}>
                {m.direction === "out" ? "You" : m.sender} · {dateTime(m.receivedAt)}
                {m.direction === "in" && !m.read && " · unread"}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <ReplyBox
          storeId={storeId}
          thread={thread}
          onSent={() => {
            mutate();
            onChanged();
            globalMutate(`/stores/${storeId}/counts`);
          }}
        />
      </div>
    </div>
  );
}
