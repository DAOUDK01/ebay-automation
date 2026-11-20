"use client";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { MessagesInbox } from "@/components/messages/MessagesInbox";

function Inbox() {
  const { id } = useParams<{ id: string }>();
  // ?thread=<id> opens that conversation (links from the dashboard)
  const thread = useSearchParams().get("thread");
  return <MessagesInbox storeId={id} initialThread={thread} />;
}

export default function MessagesPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
