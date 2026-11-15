"use client";

import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { buildNavItems, SETTINGS_NAV_ITEM } from "./nav-items";
import { NavLinks, NavLinksView } from "./nav-links";

const PRIMARY = buildNavItems();
const SECONDARY = [SETTINGS_NAV_ITEM];

export function SidebarContent({
  accountSlot,
  onNavigate,
}: {
  accountSlot?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6">
      <Link
        href="/inbox"
        onClick={onNavigate}
        className="flex items-center gap-2 px-2.5 text-sm font-semibold tracking-tight"
      >
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded-md bg-foreground text-xs font-bold text-background"
        >
          R
        </span>
        Replywise
      </Link>
      <Suspense fallback={<NavLinksView items={PRIMARY} label="Mailbox views" pathname={null} />}>
        <NavLinks items={PRIMARY} label="Mailbox views" onNavigate={onNavigate} />
      </Suspense>
      <div className="mt-auto flex flex-col gap-2">
        <Suspense fallback={<NavLinksView items={SECONDARY} label="Account" pathname={null} />}>
          <NavLinks items={SECONDARY} label="Account" onNavigate={onNavigate} />
        </Suspense>
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0 flex-1">{accountSlot}</div>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
