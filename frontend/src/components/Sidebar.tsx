"use client";
import { Check, ChevronsUpDown, LogOut, PanelLeftClose, PanelLeftOpen, Plus, Store as StoreIcon, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { api, fetcher } from "@/lib/api";
import { GLOBAL_NAV, STORE_NAV, isActive, storeHref, type NavItem } from "@/lib/nav";
import type { Counts, ModuleInfo, Store, User } from "@/lib/types";
import { cx } from "./ui";

interface SidebarProps {
  user: User;
  storeId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({ user, storeId, collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const pathname = usePathname();
  // which account modules are built (backend src/modules) and the badge numbers for this store
  const { data: mods } = useSWR<{ modules: ModuleInfo[] }>("/modules", fetcher, { revalidateOnFocus: false });
  const { data: cnt } = useSWR<{ counts: Counts }>(storeId ? `/stores/${storeId}/counts` : null, fetcher, { refreshInterval: 60_000 });
  const ready = new Set((mods?.modules ?? []).filter((m) => m.ready).map((m) => m.key));
  const resolve = (item: NavItem): { item: NavItem; badge?: number } => {
    const soon = item.soon || (item.module ? !ready.has(item.module) : false);
    const n = item.badge ? cnt?.counts?.[item.badge] : undefined;
    return { item: { ...item, soon }, badge: !soon && typeof n === "number" && n > 0 ? n : undefined };
  };

  // close the mobile drawer on navigation
  useEffect(() => {
    onCloseMobile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const panel = (isMobile: boolean) => {
    const mini = collapsed && !isMobile;
    return (
      <div className="flex h-full flex-col bg-slate-900 text-slate-300">
        {/* brand */}
        <div className={cx("flex h-14 shrink-0 items-center gap-2 border-b border-white/10", mini ? "justify-center px-2" : "px-4")}>
          <Link href="/stores" className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">
              LO
            </span>
            {!mini && <span className="truncate text-sm font-semibold text-white">Listing Optimizer</span>}
          </Link>
          {isMobile ? (
            <button onClick={onCloseMobile} className="ml-auto rounded-md p-1.5 hover:bg-white/10" aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
          ) : (
            !mini && (
              <button onClick={onToggleCollapsed} className="ml-auto rounded-md p-1.5 hover:bg-white/10" aria-label="Collapse sidebar">
                <PanelLeftClose className="h-4 w-4" />
              </button>
            )
          )}
        </div>

        {/* store switcher */}
        <div className={cx("shrink-0 border-b border-white/10", mini ? "p-2" : "p-3")}>
          <StoreSwitcher storeId={storeId} mini={mini} />
        </div>

        {/* nav */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3">
          {storeId ? (
            STORE_NAV.map((section) => (
              <div key={section.title} className="mb-4">
                {!mini && (
                  <div className="px-5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{section.title}</div>
                )}
                {mini && <div className="mx-3 mb-2 border-t border-white/10 first:hidden" />}
                <ul className="space-y-0.5 px-2">
                  {section.items.map((raw) => {
                    const { item, badge } = resolve(raw);
                    return (
                      <li key={item.label}>
                        <NavLink item={item} href={storeHref(storeId, item.path)} active={isActive(pathname, storeId, item.path)} mini={mini} badge={badge} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          ) : (
            <ul className="space-y-0.5 px-2">
              {GLOBAL_NAV.map((item) => (
                <li key={item.label}>
                  <NavLink item={item} href={item.path} active={pathname === item.path} mini={mini} />
                </li>
              ))}
            </ul>
          )}
        </nav>

        {/* footer */}
        <div className={cx("shrink-0 border-t border-white/10", mini ? "p-2" : "p-3")}>
          {mini && (
            <button
              onClick={onToggleCollapsed}
              className="mb-2 flex w-full justify-center rounded-md p-2 hover:bg-white/10"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <UserMenu user={user} mini={mini} />
        </div>
      </div>
    );
  };

  return (
    <>
      {/* desktop */}
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-40 hidden border-r border-slate-800 transition-[width] duration-200 lg:block",
          collapsed ? "w-[4.5rem]" : "w-64",
        )}
      >
        {panel(false)}
      </aside>

      {/* mobile drawer */}
      <div className={cx("fixed inset-0 z-50 lg:hidden", mobileOpen ? "" : "pointer-events-none")}>
        <div
          className={cx("absolute inset-0 bg-slate-900/60 transition-opacity", mobileOpen ? "opacity-100" : "opacity-0")}
          onClick={onCloseMobile}
        />
        <aside
          className={cx(
            "absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl transition-transform duration-200",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {panel(true)}
        </aside>
      </div>
    </>
  );
}

function NavLink({ item, href, active, mini, badge }: { item: NavItem; href: string; active: boolean; mini: boolean; badge?: number }) {
  const Icon = item.icon;
  const base = cx(
    "group relative flex items-center gap-3 rounded-md text-sm font-medium transition",
    mini ? "justify-center px-2 py-2.5" : "px-3 py-2",
  );
  if (item.soon) {
    return (
      <div className={cx(base, "cursor-default text-slate-500")} title={`${item.label} - coming soon`}>
        <Icon className="h-[18px] w-[18px] shrink-0" />
        {!mini && (
          <>
            <span className="truncate">{item.label}</span>
            <span className="ml-auto rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Soon
            </span>
          </>
        )}
      </div>
    );
  }
  return (
    <Link
      href={href}
      title={mini ? item.label : item.description}
      className={cx(base, active ? "bg-brand-600 text-white shadow-sm" : "text-slate-300 hover:bg-white/5 hover:text-white")}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!mini && <span className="truncate">{item.label}</span>}
      {badge !== undefined &&
        (mini ? (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500" />
        ) : (
          <span className="ml-auto rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {badge > 99 ? "99+" : badge}
          </span>
        ))}
    </Link>
  );
}

function StoreSwitcher({ storeId, mini }: { storeId?: string; mini: boolean }) {
  const { data } = useSWR<{ stores: Store[] }>("/stores", fetcher);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = data?.stores.find((s) => s.id === storeId);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const initial = (current?.name ?? "?").slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={mini ? current?.name ?? "Choose store" : undefined}
        className={cx(
          "flex w-full items-center gap-2.5 rounded-lg bg-white/5 text-left transition hover:bg-white/10",
          mini ? "justify-center p-2" : "px-2.5 py-2",
        )}
      >
        <span
          className={cx(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold",
            current ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-slate-400",
          )}
        >
          {current ? initial : <StoreIcon className="h-4 w-4" />}
        </span>
        {!mini && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-white">{current?.name ?? "Select a store"}</span>
              <span className="block truncate text-xs text-slate-400">
                {current ? `${current.ebayUserId} · ${current.marketplaceId}` : `${data?.stores.length ?? 0} connected`}
              </span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-500" />
          </>
        )}
      </button>

      {open && (
        <div
          className={cx(
            "absolute z-50 mt-2 w-64 overflow-hidden rounded-lg border border-slate-700 bg-slate-800 py-1 shadow-xl",
            mini ? "left-full top-0 ml-2 mt-0" : "left-0 right-0 w-auto",
          )}
        >
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">eBay stores</div>
          {data?.stores.map((s) => (
            <Link
              key={s.id}
              href={`/stores/${s.id}`}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-white/5"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded bg-white/10 text-xs font-semibold">
                {s.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.id === storeId && <Check className="h-4 w-4 text-brand-500" />}
            </Link>
          ))}
          {!data?.stores.length && <div className="px-3 py-2 text-sm text-slate-400">No stores connected yet</div>}
          <div className="my-1 border-t border-slate-700" />
          <Link href="/stores" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-white/5">
            <StoreIcon className="h-4 w-4" /> All stores
          </Link>
          <Link
            href="/stores?connect=1"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-white/5"
          >
            <Plus className="h-4 w-4" /> Connect eBay store
          </Link>
        </div>
      )}
    </div>
  );
}

function UserMenu({ user, mini }: { user: User; mini: boolean }) {
  const router = useRouter();
  async function logout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }
  const initials = (user.name || user.email).slice(0, 1).toUpperCase();
  if (mini) {
    return (
      <button onClick={logout} title={`Sign out (${user.email})`} className="flex w-full justify-center rounded-md p-2 hover:bg-white/10">
        <LogOut className="h-4 w-4" />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white">
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        {user.name && <span className="block truncate text-sm font-medium text-white">{user.name}</span>}
        <span className="block truncate text-xs text-slate-400">{user.email}</span>
      </span>
      <button onClick={logout} title="Sign out" className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}
