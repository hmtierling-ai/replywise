import { listInboxThreads, listMailAccounts } from "@replywise/db";
import Link from "next/link";
import { connection } from "next/server";
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { emptyInboxState, formatParticipants, formatThreadTime } from "@/lib/inbox-format";
import { cn } from "@/lib/utils";

/** Reads the session and DB; render inside <Suspense>. */
export async function ThreadList() {
  const user = await requireUser();
  await connection();
  const db = getDb();
  const mailboxes = await listMailAccounts(db, user.id);
  if (mailboxes.length === 0) {
    return (
      <EmptyInbox
        title="No mailboxes connected"
        description="Connect Gmail and Replywise will bring in your last 30 days of mail. Classification into Urgent, Important, Needs Reply, Informational and Low Priority arrives next."
        action={
          <Button asChild size="sm">
            <Link href="/settings/mailboxes">Connect a mailbox</Link>
          </Button>
        }
      />
    );
  }

  const threads = await listInboxThreads(db, user.id);
  if (threads.length === 0) {
    const state = emptyInboxState(mailboxes);
    if (state === "syncing") {
      return (
        <EmptyInbox
          title="Syncing your inbox…"
          description="Replywise is bringing in the last 30 days of mail. This usually takes a few minutes."
        />
      );
    }
    if (state === "needs_attention") {
      return (
        <EmptyInbox
          title="Your mailbox needs attention"
          description="Replywise can't sync right now. Check Settings → Mailboxes."
          action={
            <Button asChild size="sm">
              <Link href="/settings/mailboxes">Open mailboxes</Link>
            </Button>
          }
        />
      );
    }
    return (
      <EmptyInbox
        title="You're all caught up"
        description="There is nothing in your inbox right now."
      />
    );
  }

  const now = new Date();
  const ownEmails = mailboxes.map((m) => m.emailAddress);
  return (
    <ul className="divide-y divide-border">
      {threads.map((thread) => (
        <li key={thread.id}>
          <Link
            href={`/thread/${thread.id}`}
            data-unread={thread.isUnread ? "true" : "false"}
            className="flex flex-col gap-0.5 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-6"
          >
            <div className="flex items-baseline gap-3">
              {thread.isUnread ? (
                <span
                  role="img"
                  className="size-2 shrink-0 rounded-full bg-primary"
                  aria-label="Unread"
                />
              ) : null}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  thread.isUnread && "font-semibold",
                )}
              >
                {formatParticipants(thread.participants, ownEmails)}
              </span>
              <LocalTime
                iso={thread.lastMessageAt.toISOString()}
                serverText={formatThreadTime(thread.lastMessageAt, now)}
                className="shrink-0 text-xs text-muted-foreground"
              />
            </div>
            <p
              className={cn(
                "truncate text-sm",
                thread.isUnread ? "font-medium" : "text-foreground/90",
              )}
            >
              {thread.subject || "(no subject)"}
              {thread.messageCount > 1 ? (
                <span className="ml-1.5 text-xs text-muted-foreground">{thread.messageCount}</span>
              ) : null}
            </p>
            <p className="truncate text-sm text-muted-foreground">{thread.snippet}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"];

export function ThreadListSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:px-6" aria-hidden>
      {SKELETON_ROWS.map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
