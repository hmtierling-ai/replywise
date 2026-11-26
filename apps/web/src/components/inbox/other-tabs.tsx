import { OTHER_TABS, type OtherTab } from "@replywise/db";
import Link from "next/link";
import { cn } from "@/lib/utils";

export const OTHER_TAB_TEXT: Record<OtherTab, string> = {
  promotions: "Promotions",
  social: "Social",
  updates: "Updates",
};

export function OtherTabs({ active }: { active: OtherTab | null }) {
  const chips = [
    { href: "/other", label: "All", current: active === null },
    ...OTHER_TABS.map((tab) => ({
      href: `/other?tab=${tab}`,
      label: OTHER_TAB_TEXT[tab],
      current: active === tab,
    })),
  ];
  return (
    <nav aria-label="Gmail tabs" className="flex flex-wrap gap-2 px-4 pt-4 sm:px-6">
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          aria-current={chip.current ? "page" : undefined}
          className={cn(
            "rounded-full border border-border px-3 py-1 text-xs",
            chip.current
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {chip.label}
        </Link>
      ))}
    </nav>
  );
}
