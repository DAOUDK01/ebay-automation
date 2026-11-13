"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import useSWR from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import type { User } from "@/lib/types";
import { Spinner } from "./ui";

/** Wraps every signed-in page: checks the session and renders the top bar. */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data, error, isLoading } = useSWR<{ user: User }>("/auth/me", fetcher, { shouldRetryOnError: false });

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

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <Link href="/stores" className="flex items-center gap-2 font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-xs font-bold text-white">LO</span>
            Listing Optimizer
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/stores" className="text-slate-600 hover:text-slate-900">
              Stores
            </Link>
            <span className="hidden text-slate-400 sm:inline">{data.user.email}</span>
            <button onClick={logout} className="text-slate-600 hover:text-slate-900">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
