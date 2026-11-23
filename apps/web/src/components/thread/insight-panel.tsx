import type { ThreadInsight } from "@replywise/db";
import { CategoryBadge } from "@/components/inbox/category-badge";
import { formatScores } from "@/lib/inbox-format";

export function InsightPanel({ insight }: { insight: ThreadInsight }) {
  return (
    <section
      aria-label="Why Replywise sorted this thread"
      className="mt-4 rounded-lg border border-border bg-muted/30 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CategoryBadge category={insight.category} />
        <span className="text-muted-foreground">
          {formatScores(insight.urgency, insight.importance)}
        </span>
        {insight.needsReply ? (
          <span className="text-muted-foreground">· Needs your reply</span>
        ) : null}
      </div>
      <ul className="mt-2 list-disc pl-5 text-sm">
        {insight.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </section>
  );
}
