import type { ReactNode } from "react";
import { MobileNav } from "./mobile-nav";
import { SidebarContent } from "./sidebar-content";

export function AppShell({
  children,
  accountSlot,
}: {
  children: ReactNode;
  accountSlot?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 text-sidebar-foreground md:flex">
        <SidebarContent accountSlot={accountSlot} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-border px-3 md:hidden">
          <MobileNav accountSlot={accountSlot} />
          <span className="text-sm font-semibold tracking-tight">Replywise</span>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
