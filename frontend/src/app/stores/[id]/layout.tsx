"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import type { ReactNode } from "react";
import useSWR from "swr";
import { AppShell } from "@/components/AppShell";
import { StoreCtx, type StoreDetail } from "@/components/StoreContext";
import { Alert, Badge, Spinner, TabLink } from "@/components/ui";
import { fetcher } from "@/lib/api";

export default function StoreLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const path = usePathname();
  const { data, error, mutate } = useSWR<StoreDetail>(`/stores/${id}`, fetcher, { refreshInterval: 5000 });
  const base = `/stores/${id}`;
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/batches`, label: "Batches & review" },
    { href: `${base}/listings`, label: "Listings" },
    { href: `${base}/history`, label: "Change history" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <AppShell>
      {error ? (
        <Alert>{error.message}</Alert>
      ) : !data ? (
        <div className="flex justify-center py-20 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <StoreCtx.Provider value={{ data, mutate }}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <Link href="/stores" className="text-xs text-slate-500 hover:text-slate-700">
                ← All stores
              </Link>
              <h1 className="flex items-center gap-2 text-2xl font-semibold">
                {data.store.name}
                {data.store.runner.enabled ? <Badge color="green">running</Badge> : <Badge>paused</Badge>}
                <Badge color={data.store.settings.mode === "auto" ? "indigo" : "yellow"}>{data.store.settings.mode} mode</Badge>
              </h1>
            </div>
          </div>
          <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200">
            {tabs.map((t) => (
              <TabLink key={t.href} href={t.href} active={t.href === base ? path === base : path.startsWith(t.href)}>
                {t.label}
              </TabLink>
            ))}
          </nav>
          {children}
        </StoreCtx.Provider>
      )}
    </AppShell>
  );
}
