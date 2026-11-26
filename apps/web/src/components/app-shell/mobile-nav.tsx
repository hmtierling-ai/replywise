"use client";

import type { ThreadViewCounts } from "@replywise/db";
import { Menu } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarContent } from "./sidebar-content";

export function MobileNav({
  accountSlot,
  counts,
}: {
  accountSlot?: ReactNode;
  counts?: Promise<ThreadViewCounts | null>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open navigation">
          <Menu className="size-4" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 bg-sidebar px-3 py-4">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarContent
          accountSlot={accountSlot}
          onNavigate={() => setOpen(false)}
          {...(counts ? { counts } : {})}
        />
      </SheetContent>
    </Sheet>
  );
}
