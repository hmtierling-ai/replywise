import type { EmailAddress, MailProviderId } from "@replywise/core";
import { and, arrayContains, asc, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "../client";
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
}

export async function listInboxThreads(
  db: DbExecutor,
  userId: string,
  limit = 50,
): Promise<InboxThread[]> {
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
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(and(eq(mailAccounts.userId, userId), arrayContains(threads.providerLabels, ["INBOX"])))
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
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
