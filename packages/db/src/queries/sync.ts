import type { EmailAddress, MailProviderId } from "@replywise/core";
import { and, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { userPreferences } from "../schema/ai";
import { mailAccounts, messages, threads } from "../schema/mail";

/**
 * Takes the sync lease if it is free or expired. Returns the lease-until value it set (the
 * caller's ownership token for releaseSyncLease), or null when another run holds the lease.
 */
export async function acquireSyncLease(
  db: DbExecutor,
  mailAccountId: string,
  now: Date,
  leaseMs: number,
): Promise<Date | null> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const rows = await db
    .update(mailAccounts)
    .set({ syncLeaseUntil: leaseUntil })
    .where(
      and(
        eq(mailAccounts.id, mailAccountId),
        eq(mailAccounts.status, "active"),
        or(isNull(mailAccounts.syncLeaseUntil), lte(mailAccounts.syncLeaseUntil, now)),
      ),
    )
    .returning({ id: mailAccounts.id });
  return rows.length > 0 ? leaseUntil : null;
}

/** Releases the lease only if it is still the one this run acquired (`leaseUntil`). */
export async function releaseSyncLease(
  db: DbExecutor,
  mailAccountId: string,
  leaseUntil: Date,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ syncLeaseUntil: null })
    .where(and(eq(mailAccounts.id, mailAccountId), eq(mailAccounts.syncLeaseUntil, leaseUntil)));
}

export async function listSyncableMailAccounts(
  db: DbExecutor,
): Promise<Array<{ id: string; provider: MailProviderId }>> {
  return db
    .select({ id: mailAccounts.id, provider: mailAccounts.provider })
    .from(mailAccounts)
    .where(eq(mailAccounts.status, "active"));
}

export interface ThreadWrite {
  providerThreadId: string;
  subject: string;
  snippet: string;
  participants: EmailAddress[];
  lastMessageAt: Date;
  messageCount: number;
  isUnread: boolean;
  providerLabels: string[];
}

export async function upsertThread(
  db: DbExecutor,
  mailAccountId: string,
  t: ThreadWrite,
): Promise<string> {
  const values = {
    subject: t.subject,
    snippet: t.snippet,
    participants: t.participants,
    lastMessageAt: t.lastMessageAt,
    messageCount: t.messageCount,
    isUnread: t.isUnread,
    providerLabels: t.providerLabels,
  };
  const [row] = await db
    .insert(threads)
    .values({ mailAccountId, providerThreadId: t.providerThreadId, ...values })
    .onConflictDoUpdate({ target: [threads.mailAccountId, threads.providerThreadId], set: values })
    .returning({ id: threads.id });
  if (!row) throw new Error("upsertThread returned no row");
  return row.id;
}

export interface MessageWrite {
  providerMessageId: string;
  internetMessageId: string | null;
  fromAddress: EmailAddress;
  toAddresses: EmailAddress[];
  ccAddresses: EmailAddress[];
  subject: string;
  snippet: string;
  sentAt: Date;
  isFromUser: boolean;
  hasAttachments: boolean;
}

export async function upsertMessage(
  db: DbExecutor,
  threadId: string,
  mailAccountId: string,
  m: MessageWrite,
): Promise<string> {
  const { providerMessageId, ...values } = m;
  const [row] = await db
    .insert(messages)
    .values({ threadId, mailAccountId, providerMessageId, ...values })
    .onConflictDoUpdate({
      target: [messages.mailAccountId, messages.providerMessageId],
      set: { threadId, ...values },
    })
    .returning({ id: messages.id });
  if (!row) throw new Error("upsertMessage returned no row");
  return row.id;
}

export async function setMessageBody(
  db: DbExecutor,
  messageId: string,
  ciphertext: Buffer,
  expiresAt: Date,
): Promise<void> {
  await db
    .update(messages)
    .set({ bodyCiphertext: ciphertext, bodyExpiresAt: expiresAt })
    .where(eq(messages.id, messageId));
}

export async function deleteMessagesNotIn(
  db: DbExecutor,
  threadId: string,
  keepProviderMessageIds: string[],
): Promise<number> {
  const deleted = await db
    .delete(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        notInArray(messages.providerMessageId, keepProviderMessageIds),
      ),
    )
    .returning({ id: messages.id });
  return deleted.length;
}

export async function deleteThreadsByProviderIds(
  db: DbExecutor,
  mailAccountId: string,
  providerThreadIds: string[],
): Promise<number> {
  if (providerThreadIds.length === 0) return 0;
  const deleted = await db
    .delete(threads)
    .where(
      and(
        eq(threads.mailAccountId, mailAccountId),
        inArray(threads.providerThreadId, providerThreadIds),
      ),
    )
    .returning({ id: threads.id });
  return deleted.length;
}

/** Deletes every thread of the mailbox whose provider id is not in `keepProviderThreadIds`. */
export async function deleteThreadsNotIn(
  db: DbExecutor,
  mailAccountId: string,
  keepProviderThreadIds: string[],
): Promise<number> {
  const deleted = await db
    .delete(threads)
    .where(
      keepProviderThreadIds.length === 0
        ? eq(threads.mailAccountId, mailAccountId)
        : and(
            eq(threads.mailAccountId, mailAccountId),
            notInArray(threads.providerThreadId, keepProviderThreadIds),
          ),
    )
    .returning({ id: threads.id });
  return deleted.length;
}

export async function deleteMessagesByProviderIds(
  db: DbExecutor,
  mailAccountId: string,
  providerMessageIds: string[],
): Promise<number> {
  if (providerMessageIds.length === 0) return 0;
  const deleted = await db
    .delete(messages)
    .where(
      and(
        eq(messages.mailAccountId, mailAccountId),
        inArray(messages.providerMessageId, providerMessageIds),
      ),
    )
    .returning({ id: messages.id });
  return deleted.length;
}

export async function recordSyncSuccess(
  db: DbExecutor,
  mailAccountId: string,
  cursor: string,
  now: Date,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ syncCursor: cursor, lastSyncedAt: now, lastError: null })
    .where(eq(mailAccounts.id, mailAccountId));
}

/** `message` must be a fixed, non-secret string (see sync's describeSyncError). */
export async function recordSyncFailure(
  db: DbExecutor,
  mailAccountId: string,
  message: string,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ lastError: message })
    .where(eq(mailAccounts.id, mailAccountId));
}

export const DEFAULT_BODY_CACHE_DAYS = 14;

export async function getBodyCacheDays(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ days: userPreferences.bodyCacheDays })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return row?.days ?? DEFAULT_BODY_CACHE_DAYS;
}
