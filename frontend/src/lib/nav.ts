/**
 * Sidebar navigation - the single place to register app sections.
 * To add a feature: build its page under src/app/stores/[id]/<path>, then add an item here
 * (remove `soon: true` once it exists).
 */
import {
  BarChart3,
  Boxes,
  History,
  LayoutDashboard,
  MessageSquare,
  Megaphone,
  Package,
  Settings,
  ShoppingCart,
  Star,
  Store,
  Truck,
  Undo2,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  icon: LucideIcon;
  /** path relative to the store, e.g. "batches" ("" = store dashboard) */
  path: string;
  /** feature not built yet - shown greyed out with a "Soon" tag */
  soon?: boolean;
  description?: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const STORE_NAV: NavSection[] = [
  {
    title: "Overview",
    items: [{ label: "Dashboard", icon: LayoutDashboard, path: "" }],
  },
  {
    title: "Listing Optimizer",
    items: [
      { label: "Review & batches", icon: WandSparkles, path: "batches", description: "AI suggestions waiting for approval" },
      { label: "Listings", icon: Package, path: "listings", description: "All active listings and your costs" },
      { label: "Change history", icon: History, path: "history", description: "Everything pushed to eBay, with revert" },
    ],
  },
  {
    title: "Sales",
    items: [
      { label: "Orders", icon: ShoppingCart, path: "orders", soon: true },
      { label: "Returns & cases", icon: Undo2, path: "returns", soon: true },
      { label: "Messages", icon: MessageSquare, path: "messages", soon: true },
      { label: "Feedback", icon: Star, path: "feedback", soon: true },
    ],
  },
  {
    title: "Growth",
    items: [
      { label: "Promotions", icon: Megaphone, path: "promotions", soon: true },
      { label: "Analytics", icon: BarChart3, path: "analytics", soon: true },
    ],
  },
  {
    title: "Operations",
    items: [
      { label: "Inventory & restock", icon: Boxes, path: "inventory", soon: true },
      { label: "Shipping", icon: Truck, path: "shipping", soon: true },
    ],
  },
  {
    title: "Store",
    items: [{ label: "Settings", icon: Settings, path: "settings" }],
  },
];

export const GLOBAL_NAV: NavItem[] = [{ label: "All stores", icon: Store, path: "/stores" }];

export const storeHref = (storeId: string, path: string) => `/stores/${storeId}${path ? `/${path}` : ""}`;

/** Which nav item is active for a pathname. Dashboard only matches exactly. */
export function isActive(pathname: string, storeId: string, path: string) {
  const href = storeHref(storeId, path);
  return path === "" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function findNavItem(pathname: string, storeId: string): NavItem | undefined {
  for (const s of STORE_NAV) for (const i of s.items) if (isActive(pathname, storeId, i.path)) return i;
  return undefined;
}
