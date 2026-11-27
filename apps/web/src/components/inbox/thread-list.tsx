import { CATEGORY_META, type InboxCategory } from "@replywise/core";
import {
  type InboxThread,
  listInboxThreads,
  listMailAccounts,
  listOtherThreads,
  listSentThreads,
  type OtherTab,
  type SearchThread,
  type ThreadLocation,
} from "@replywise/db";
import Link from "next/link";
import { connection } from "next/server";
import { CategoryBadge } from "@/components/inbox/category-badge";
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { OTHER_TAB_TEXT } from "@/components/inbox/other-tabs";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { emptyInboxState, formatParticipants, formatThreadTime } from "@/lib/inbox-format";
import { cn } from "@/lib/utils";

export type ThreadListView =
  | { kind: "inbox"; category?: InboxCategory }
  | { kind: "sent" }
  | { kind: "other"; tab: OtherTab | null };

const LOCATION_TEXT: Record<ThreadLocation, string> = {
  inbox: "Inbox",
  other: "Other",
  sent: "Sent",
  archived: "Archived",
};

function loadThreads(
  db: ReturnType<typeof getDb>,
  userId: string,
  view: ThreadListView,
): Promise<InboxThread[]> {
  if (view.kind === "sent") return listSentThreads(db, userId);
  if (view.kind === "other") return listOtherThreads(db, userId, { tab: view.tab });
  return listInboxThreads(db, userId, view.category ? { category: view.category } : {});
}

/** Empty copy for views that are not the main inbox (which has its own sync-aware states). */
function emptyView(view: ThreadListView): { title: string; description: string } | null {
  if (view.kind === "sent") {
    return {
      title: "No sent mail yet",
      description: "Conversations you wrote in during the last 30 days show up here.",
    };
  }
  if (view.kind === "other") {
    return view.tab
      ? {
          title: `Nothing in ${OTHER_TAB_TEXT[view.tab]}`,
          description: "Gmail files this kind of mail under its own tab.",
        }
      : {
          title: "Nothing in Other",
          description: "Promotions, social and update mail you never replied to shows up here.",
        };
  }
  if (view.category) {
    return {
      title: `Nothing in ${CATEGORY_META[view.category].label}`,
      description: CATEGORY_META[view.category].description,
    };
  }
  return null;
}

/** Reads the session and DB; render inside <Suspense>. */
export async function ThreadList({ view }: { view: ThreadListView }) {
  const user = await requireUser();
  await connection();
  const db = getDb();
  const mailboxes = await listMailAccounts(db, user.id);
  if (mailboxes.length === 0) {
    return (
      <EmptyInbox
        title="No mailboxes connected"
        description="Connect Gmail and Replywise will bring in your last 30 days of mail and sort it by what needs you."
        action={
          <Button asChild size="sm">
            <Link href="/settings/mailboxes">Connect a mailbox</Link>
          </Button>
        }
      />
    );
  }

  const threads = await loadThreads(db, user.id, view);
  const empty = threads.length === 0 ? emptyView(view) : null;
  if (empty) return <EmptyInbox title={empty.title} description={empty.description} />;
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
  return <ThreadRows threads={threads} ownEmails={ownEmails} now={now} />;
}

export function ThreadRows({
  threads,
  ownEmails,
  now,
}: {
  threads: Array<InboxThread | SearchThread>;
  ownEmails: string[];
  now: Date;
}) {
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
              {thread.category ? <CategoryBadge category={thread.category} /> : null}
              {"location" in thread ? (
                <Badge variant="outline">{LOCATION_TEXT[thread.location]}</Badge>
              ) : null}
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
            {thread.reasons?.[0] ? (
              <p className="truncate text-xs text-muted-foreground">
                <span className="sr-only">Why: </span>
                {thread.reasons[0]}
              </p>
            ) : null}
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
