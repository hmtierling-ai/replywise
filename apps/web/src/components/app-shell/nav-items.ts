import { CATEGORY_META, INBOX_CATEGORIES, type InboxCategory } from "@replywise/core";

export type NavIcon = "inbox" | "settings" | InboxCategory;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

export function buildNavItems(): NavItem[] {
  return [
    { href: "/inbox", label: "All mail", icon: "inbox" },
    ...INBOX_CATEGORIES.map((category) => ({
      href: `/inbox/${CATEGORY_META[category].slug}`,
      label: CATEGORY_META[category].label,
      icon: category,
    })),
  ];
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
