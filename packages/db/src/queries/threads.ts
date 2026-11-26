import {
  type EmailAddress,
  INBOX_CATEGORIES,
  type InboxCategory,
  type MailProviderId,
} from "@replywise/core";
import { type AnyColumn, and, arrayContains, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { threadInsights } from "../schema/ai";
import { mailAccounts, messages, threads } from "../schema/mail";

export interface InboxThread {
  id: string;
  subject: string;
  snippet: string;
  participants: EmailAddress[];
  lastMessageAt: Date;
  messageCount: number;
  isUnread: boolean;
  mailAccountId: string;
  mailboxEmail: string;
  category: InboxCategory | null;
  urgency: number | null;
  importance: number | null;
  reasons: string[] | null;
}

/** Gmail tab labels that make a thread "Other" (spec M6 §4). */
export const OTHER_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"] as const;
export const OTHER_TABS = ["promotions", "social", "updates"] as const;
export type OtherTab = (typeof OTHER_TABS)[number];
export const OTHER_TAB_LABEL: Record<OtherTab, (typeof OTHER_LABELS)[number]> = {
  promotions: "CATEGORY_PROMOTIONS",
  social: "CATEGORY_SOCIAL",
  updates: "CATEGORY_UPDATES",
};

export function isOtherTab(value: string): value is OtherTab {
  return (OTHER_TABS as readonly string[]).includes(value);
}

/**
 * The one definition of "Other" (spec M6 §4): Gmail filed the thread under Promotions, Social or
 * Updates, and no message in it is from the user. Every list, count and scan uses this helper.
 * Pass columns (`threads.id`) or raw aliases (sql`t.id`) for queries that alias the table.
 */
export function otherThreadSql(threadId: AnyColumn | SQL, labels: AnyColumn | SQL): SQL {
  return sql`(${labels} && array['CATEGORY_PROMOTIONS','CATEGORY_SOCIAL','CATEGORY_UPDATES']::text[]
    and not exists (
      select 1 from ${messages} om where om.thread_id = ${threadId} and om.is_from_user = true
    ))`;
}

const notOther = () => sql`not ${otherThreadSql(threads.id, threads.providerLabels)}`;
const inInbox = () => arrayContains(threads.providerLabels, ["INBOX"]);

/** Select shape of `InboxThread` (threads + mailbox address + optional insight). */
export const threadListColumns = {
  id: threads.id,
  subject: threads.subject,
  snippet: threads.snippet,
  participants: threads.participants,
  lastMessageAt: threads.lastMessageAt,
  messageCount: threads.messageCount,
  isUnread: threads.isUnread,
  mailAccountId: threads.mailAccountId,
  mailboxEmail: mailAccounts.emailAddress,
  category: threadInsights.category,
  urgency: threadInsights.urgency,
  importance: threadInsights.importance,
  reasons: threadInsights.reasons,
};

function selectThreads(
  db: DbExecutor,
  userId: string,
  conditions: SQL[],
  limit: number,
): Promise<InboxThread[]> {
  return db
    .select(threadListColumns)
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .leftJoin(threadInsights, eq(threadInsights.threadId, threads.id))
    .where(and(eq(mailAccounts.userId, userId), ...conditions))
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
}

/** Main inbox and AI tabs: INBOX threads that are not Other. */
export async function listInboxThreads(
  db: DbExecutor,
  userId: string,
  options: { limit?: number; category?: InboxCategory } = {},
): Promise<InboxThread[]> {
  const conditions: SQL[] = [inInbox(), notOther()];
  if (options.category) conditions.push(eq(threadInsights.category, options.category));
  return selectThreads(db, userId, conditions, options.limit ?? 50);
}

/** Threads with a message the user sent (Gmail label SENT). */
export async function listSentThreads(
  db: DbExecutor,
  userId: string,
  options: { limit?: number } = {},
): Promise<InboxThread[]> {
  return selectThreads(
    db,
    userId,
    [arrayContains(threads.providerLabels, ["SENT"])],
    options.limit ?? 50,
  );
}

/** INBOX threads that are Other, optionally one Gmail tab. */
export async function listOtherThreads(
  db: DbExecutor,
  userId: string,
  options: { tab?: OtherTab | null; limit?: number } = {},
): Promise<InboxThread[]> {
  const conditions: SQL[] = [inInbox(), otherThreadSql(threads.id, threads.providerLabels)];
  if (options.tab) {
    conditions.push(arrayContains(threads.providerLabels, [OTHER_TAB_LABEL[options.tab]]));
  }
  return selectThreads(db, userId, conditions, options.limit ?? 50);
}

export interface ThreadViewCounts {
  inbox: number;
  other: number;
  categories: Record<InboxCategory, number>;
}

/** Thread counts for the nav, with exactly the list queries' rules. */
export async function countThreadViews(db: DbExecutor, userId: string): Promise<ThreadViewCounts> {
  const rows = await db
    .select({
      other: sql<boolean>`${otherThreadSql(threads.id, threads.providerLabels)}`,
      category: threadInsights.category,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .leftJoin(threadInsights, eq(threadInsights.threadId, threads.id))
    .where(and(eq(mailAccounts.userId, userId), inInbox()))
    .groupBy(sql`1`, sql`2`);
  const categories = Object.fromEntries(INBOX_CATEGORIES.map((c) => [c, 0])) as Record<
    InboxCategory,
    number
  >;
  const counts: ThreadViewCounts = { inbox: 0, other: 0, categories };
  for (const row of rows) {
    if (row.other) {
      counts.other += row.n;
      continue;
    }
    counts.inbox += row.n;
    if (row.category) counts.categories[row.category] += row.n;
  }
  return counts;
}

export interface ThreadDetail {
  thread: { id: string; subject: string; providerThreadId: string; lastMessageAt: Date };
  mailbox: {
    id: string;
    provider: MailProviderId;
    emailAddress: string;
    status: "active" | "needs_reauth" | "error";
  };
  messages: Array<typeof messages.$inferSelect>;
}

export async function getThreadForUser(
  db: DbExecutor,
  userId: string,
  threadId: string,
): Promise<ThreadDetail | null> {
  const [row] = await db
    .select({
      thread: {
        id: threads.id,
        subject: threads.subject,
        providerThreadId: threads.providerThreadId,
        lastMessageAt: threads.lastMessageAt,
      },
      mailbox: {
        id: mailAccounts.id,
        provider: mailAccounts.provider,
        emailAddress: mailAccounts.emailAddress,
        status: mailAccounts.status,
      },
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(and(eq(threads.id, threadId), eq(mailAccounts.userId, userId)));
  if (!row) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.sentAt));
  return { ...row, messages: rows };
}
