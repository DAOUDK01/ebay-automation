"use client";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import type { ReactNode } from "react";
import useSWR from "swr";
import { AppShell } from "@/components/AppShell";
import { StoreCtx, type StoreDetail } from "@/components/StoreContext";
import { Alert, Badge, Spinner } from "@/components/ui";
import { fetcher } from "@/lib/api";
import { findNavItem, storeHref } from "@/lib/nav";

export default function StoreLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { data, error, mutate } = useSWR<StoreDetail>(`/stores/${id}`, fetcher, { refreshInterval: 5000 });
  const page = findNavItem(pathname, id);
  const PageIcon = page?.icon;
  // nested pages (a single listing, a single batch) render their own header
  const isSectionRoot = page ? pathname === storeHref(id, page.path) : false;

  const header = (
    <nav className="flex min-w-0 items-center gap-1.5 text-sm">
      <Link href={`/stores/${id}`} className="truncate font-medium text-slate-500 hover:text-slate-800">
        {data?.store.name ?? "Store"}
      </Link>
      {page && (
        <>
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
          <span className="truncate font-medium text-slate-900">{page.label}</span>
        </>
      )}
    </nav>
  );

  const actions = data && (
    <div className="hidden items-center gap-2 sm:flex">
      {data.store.runner.enabled ? (
        <Badge color="green">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          Runner on
        </Badge>
      ) : (
        <Badge>Runner paused</Badge>
      )}
      <Badge color={data.store.settings.mode === "auto" ? "indigo" : "yellow"}>{data.store.settings.mode} mode</Badge>
    </div>
  );

  return (
    <AppShell header={header} actions={actions}>
      {error ? (
        <Alert>{error.message}</Alert>
      ) : !data ? (
        <div className="flex justify-center py-20 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <StoreCtx.Provider value={{ data, mutate }}>
          {page && isSectionRoot && (
            <div className="mb-6 flex items-start gap-3">
              {PageIcon && (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <PageIcon className="h-5 w-5" />
                </span>
              )}
              <div className="min-w-0">
                <h1 className="text-xl font-semibold text-slate-900">{page.path === "" ? data.store.name : page.label}</h1>
                <p className="text-sm text-slate-500">
                  {page.path === ""
                    ? `${data.store.ebayUserId} · ${data.store.marketplaceId}`
                    : page.description ?? `${data.store.name} settings`}
                </p>
              </div>
            </div>
          )}
          {children}
        </StoreCtx.Provider>
      )}
    </AppShell>
  );
}
