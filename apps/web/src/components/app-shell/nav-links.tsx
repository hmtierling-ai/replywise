"use client";

import type { ThreadViewCounts } from "@replywise/db";
import {
  BellOff,
  Flame,
  Inbox,
  Info,
  Layers,
  type LucideIcon,
  Reply,
  Send,
  Settings,
  Star,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use } from "react";
import { cn } from "@/lib/utils";
import { isActive, type NavIcon, type NavItem, navCount } from "./nav-items";

const ICONS: Record<NavIcon, LucideIcon> = {
  inbox: Inbox,
  settings: Settings,
  sent: Send,
  other: Layers,
  urgent: Flame,
  important: Star,
  needs_reply: Reply,
  informational: Info,
  low_priority: BellOff,
};

interface NavLinksProps {
  items: NavItem[];
  label: string;
  onNavigate?: () => void;
}

/** Pure view; `pathname: null` renders without an active item (Suspense fallback). */
export function NavLinksView({
  items,
  label,
  onNavigate,
  pathname,
  counts,
}: NavLinksProps & { pathname: string | null; counts?: ThreadViewCounts | null }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = pathname !== null && isActive(pathname, item.href);
        const count = navCount(counts, item.countKey);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {item.label}
            {count ? (
              <>
                <span aria-hidden className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {count > 99 ? "99+" : count}
                </span>
                <span className="sr-only">{`, ${count} ${count === 1 ? "thread" : "threads"}`}</span>
              </>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Reads the current path (and the counts promise). Must render inside <Suspense>. */
export function NavLinks({
  counts,
  ...props
}: NavLinksProps & { counts?: Promise<ThreadViewCounts | null> }) {
  const pathname = usePathname();
  const resolved = counts ? use(counts) : null;
  return <NavLinksView {...props} counts={resolved} pathname={pathname} />;
}
