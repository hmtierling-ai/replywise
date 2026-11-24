import type { ThreadSummary } from "@replywise/db";
import Link from "next/link";
import { summarizeThreadAction } from "@/app/(app)/thread/[id]/actions";
import { Button } from "@/components/ui/button";
import { generationError } from "@/lib/draft-messages";

function SummarizeForm({ threadId, label }: { threadId: string; label: string }) {
  return (
    <form action={summarizeThreadAction}>
      <input type="hidden" name="threadId" value={threadId} />
      <Button type="submit" size="sm" variant="outline">
        {label}
      </Button>
    </form>
  );
}

export function SummaryPanel({
  threadId,
  summary,
  newestMessageId,
  hasValidKey,
}: {
  threadId: string;
  summary: ThreadSummary | null;
  newestMessageId: string | null;
  hasValidKey: boolean;
}) {
  const keyLink = (
    <Link href="/settings/ai" className="text-sm underline underline-offset-4">
      Add your Anthropic key to summarize
    </Link>
  );
  const action = (label: string) =>
    hasValidKey ? <SummarizeForm threadId={threadId} label={label} /> : keyLink;

  let content: React.ReactNode;
  if (!summary) {
    content = action("Summarize");
  } else if (summary.status === "pending") {
    content = (
      <>
        <p role="status" className="text-sm font-medium">
          Summarizing…
        </p>
        {summary.summary ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {summary.summary}
          </p>
        ) : null}
      </>
    );
  } else if (summary.status === "failed") {
    content = (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          {generationError(summary.error)}
        </p>
        {action("Try again")}
      </div>
    );
  } else {
    const stale = summary.throughMessageId !== newestMessageId;
    content = (
      <div className="flex flex-col items-start gap-2">
        {stale ? <p className="text-xs font-medium text-muted-foreground">Out of date</p> : null}
        <p className="whitespace-pre-wrap text-sm">{summary.summary}</p>
        {action("Refresh summary")}
      </div>
    );
  }

  return (
    <section aria-label="Thread summary" className="mt-4 rounded-lg border border-border px-4 py-3">
      <h2 className="mb-2 text-sm font-semibold">Summary</h2>
      {content}
    </section>
  );
}
