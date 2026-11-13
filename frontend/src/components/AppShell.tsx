"use client";
import { Menu } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { ApiError, fetcher } from "@/lib/api";
import type { User } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { Spinner, cx } from "./ui";

const COLLAPSE_KEY = "lo.sidebarCollapsed";

/**
 * Wraps every signed-in page: checks the session, renders the sidebar + top bar.
 * `header` is shown in the top bar (page title / breadcrumbs), `actions` on its right.
 */
export function AppShell({ children, header, actions }: { children: ReactNode; header?: ReactNode; actions?: ReactNode }) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const storeId = typeof params?.id === "string" ? params.id : undefined;
  const { data, error, isLoading } = useSWR<{ user: User }>("/auth/me", fetcher, { shouldRetryOnError: false });
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  }, []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/login");
  }, [error, router]);

  if (isLoading || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        {error && !(error instanceof ApiError && error.status === 401) ? (
          <div className="text-sm text-rose-600">Cannot reach the API: {String(error.message)}</div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar
        user={data.user}
        storeId={storeId}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
      />
      <div className={cx("flex min-h-screen flex-col transition-[padding] duration-200", collapsed ? "lg:pl-[4.5rem]" : "lg:pl-64")}>
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            className="-ml-1 rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">{header}</div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
