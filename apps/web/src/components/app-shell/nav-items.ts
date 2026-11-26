import { CATEGORY_META, INBOX_CATEGORIES, type InboxCategory } from "@replywise/core";
import type { ThreadViewCounts } from "@replywise/db";

export type NavIcon = "inbox" | "settings" | "sent" | "other" | InboxCategory;
export type NavCountKey = "inbox" | "other" | InboxCategory;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  countKey?: NavCountKey;
}

export function buildNavItems(): NavItem[] {
  return [
    { href: "/inbox", label: "All mail", icon: "inbox", countKey: "inbox" },
    ...INBOX_CATEGORIES.map((category) => ({
      href: `/inbox/${CATEGORY_META[category].slug}`,
      label: CATEGORY_META[category].label,
      icon: category,
      countKey: category,
    })),
    { href: "/other", label: "Other", icon: "other", countKey: "other" },
    { href: "/sent", label: "Sent", icon: "sent" },
  ];
}

export function navCount(
  counts: ThreadViewCounts | null | undefined,
  key: NavCountKey | undefined,
): number | null {
  if (!counts || !key) return null;
  if (key === "inbox") return counts.inbox;
  if (key === "other") return counts.other;
  return counts.categories[key];
}

export const SETTINGS_NAV_ITEM: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: "settings",
};

export function isActive(pathname: string, href: string): boolean {
  if (href === "/inbox") return pathname === "/inbox";
  return pathname === href || pathname.startsWith(`${href}/`);
}
