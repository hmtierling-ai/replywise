import { CATEGORY_META, type InboxCategory } from "@replywise/core";
import { Badge } from "@/components/ui/badge";

const VARIANT = {
  urgent: "destructive",
  important: "default",
  needs_reply: "secondary",
  informational: "outline",
  low_priority: "ghost",
} as const satisfies Record<
  InboxCategory,
  "destructive" | "default" | "secondary" | "outline" | "ghost"
>;

export function CategoryBadge({ category }: { category: InboxCategory }) {
  return (
    <Badge variant={VARIANT[category]} data-category={category}>
      {CATEGORY_META[category].label}
    </Badge>
  );
}
