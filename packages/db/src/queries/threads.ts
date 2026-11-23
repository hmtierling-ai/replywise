import type { EmailAddress, InboxCategory, MailProviderId } from "@replywise/core";
import { and, arrayContains, asc, desc, eq, type SQL } from "drizzle-orm";
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

export async function listInboxThreads(
  db: DbExecutor,
  userId: string,
  options: { limit?: number; category?: InboxCategory } = {},
): Promise<InboxThread[]> {
  const conditions: SQL[] = [
    eq(mailAccounts.userId, userId),
    arrayContains(threads.providerLabels, ["INBOX"]),
  ];
  if (options.category) conditions.push(eq(threadInsights.category, options.category));
  return db
    .select({
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
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .leftJoin(threadInsights, eq(threadInsights.threadId, threads.id))
    .where(and(...conditions))
    .orderBy(desc(threads.lastMessageAt))
    .limit(options.limit ?? 50);
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
