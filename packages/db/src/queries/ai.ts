import {
  type AiProviderId,
  type AiTask,
  DEFAULT_AI_MODELS,
  type InboxCategory,
  type MailProviderId,
} from "@replywise/core";
import { and, eq, gte, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { aiCredentials, aiUsageEvents, threadInsights, userPreferences } from "../schema/ai";
import { mailAccounts, messages, threads } from "../schema/mail";

type CredentialStatus = "unverified" | "valid" | "invalid";

export interface AiCredentialSummary {
  keyHint: string;
  status: CredentialStatus;
  lastValidatedAt: Date | null;
}

/** Creates or replaces the user's Anthropic key (one per user and provider). */
export async function saveAiCredential(
  db: DbExecutor,
  input: {
    userId: string;
    keyCiphertext: Buffer;
    keyHint: string;
    status: CredentialStatus;
    lastValidatedAt: Date | null;
  },
): Promise<void> {
  const values = {
    keyCiphertext: input.keyCiphertext,
    keyHint: input.keyHint,
    status: input.status,
    lastValidatedAt: input.lastValidatedAt,
  };
  await db
    .insert(aiCredentials)
    .values({ userId: input.userId, provider: "anthropic", ...values })
    .onConflictDoUpdate({
      target: [aiCredentials.userId, aiCredentials.provider],
      set: { ...values, updatedAt: new Date() },
    });
}

/** Browser-safe view of the key: hint and status only. */
export async function getAiCredentialSummary(
  db: DbExecutor,
  userId: string,
): Promise<AiCredentialSummary | null> {
  const [row] = await db
    .select({
      keyHint: aiCredentials.keyHint,
      status: aiCredentials.status,
      lastValidatedAt: aiCredentials.lastValidatedAt,
    })
    .from(aiCredentials)
    .where(and(eq(aiCredentials.userId, userId), eq(aiCredentials.provider, "anthropic")));
  return row ?? null;
}

/** Server-only: the encrypted key for just-in-time decryption. Never send to the browser. */
export async function getAiCredentialForUse(
  db: DbExecutor,
  userId: string,
): Promise<{ keyCiphertext: Buffer; status: CredentialStatus; updatedAt: Date } | null> {
  const [row] = await db
    .select({
      keyCiphertext: aiCredentials.keyCiphertext,
      status: aiCredentials.status,
      updatedAt: aiCredentials.updatedAt,
    })
    .from(aiCredentials)
    .where(and(eq(aiCredentials.userId, userId), eq(aiCredentials.provider, "anthropic")));
  return row ?? null;
}

/**
 * With `version` (the `updatedAt` read alongside the key), only that key version is invalidated,
 * so a late 401 for an old key cannot reject a key the user has just replaced. Compared at ms
 * precision because JS dates carry no µs.
 */
export async function markAiCredentialInvalid(
  db: DbExecutor,
  userId: string,
  version?: Date,
): Promise<void> {
  await db
    .update(aiCredentials)
    .set({ status: "invalid", updatedAt: new Date() })
    .where(
      and(
        eq(aiCredentials.userId, userId),
        eq(aiCredentials.provider, "anthropic"),
        version
          ? sql`date_trunc('milliseconds', ${aiCredentials.updatedAt}) = ${version.toISOString()}::timestamptz`
          : undefined,
      ),
    );
}

export async function deleteAiCredential(db: DbExecutor, userId: string): Promise<boolean> {
  const rows = await db
    .delete(aiCredentials)
    .where(and(eq(aiCredentials.userId, userId), eq(aiCredentials.provider, "anthropic")))
    .returning({ id: aiCredentials.id });
  return rows.length > 0;
}

export async function getClassificationModel(db: DbExecutor, userId: string): Promise<string> {
  const [row] = await db
    .select({ model: userPreferences.classificationModel })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return row?.model ?? DEFAULT_AI_MODELS.classification;
}

export async function setClassificationModel(
  db: DbExecutor,
  userId: string,
  model: string,
): Promise<void> {
  await db
    .insert(userPreferences)
    .values({ userId, classificationModel: model })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { classificationModel: model, updatedAt: new Date() },
    });
}

export interface InsightWrite {
  threadId: string;
  category: InboxCategory;
  urgency: number;
  importance: number;
  needsReply: boolean;
  reasons: string[];
  classifiedThroughMessageId: string;
  aiProvider: AiProviderId;
  model: string;
  promptVersion: string;
}

/** Returns false when the race guard skipped the write (the user already replied). */
export async function upsertThreadInsight(db: DbExecutor, input: InsightWrite): Promise<boolean> {
  const { threadId, ...rest } = input;
  // Skip when the user has already replied after the classified message (the reply clears
  // needs_reply in sync; an in-flight classification must not resurrect it). A missing base
  // message allows the write, because there is nothing to compare against.
  const rows = await db.execute<{ answered: boolean }>(sql`
    select exists (
      select 1 from ${messages} newer, ${messages} base
      where base.id = ${input.classifiedThroughMessageId}
        and base.thread_id = ${threadId}
        and newer.thread_id = ${threadId}
        and newer.is_from_user = true
        and (newer.sent_at, newer.id) > (base.sent_at, base.id)
    ) as answered
  `);
  if ([...rows][0]?.answered) return false;
  await db
    .insert(threadInsights)
    .values(input)
    .onConflictDoUpdate({
      target: threadInsights.threadId,
      set: { ...rest, updatedAt: new Date() },
    });
  return true;
}

/**
 * The user replied last: clear needs_reply without an AI call. The CASE mirrors `deriveCategory`
 * (@replywise/core) with needsReply=false; keep the two in sync (parity-tested in
 * ai.int.test.ts). `classified_through_message_id` is untouched, so the scan is unaffected.
 */
export async function markThreadAnswered(db: DbExecutor, threadId: string): Promise<void> {
  await db
    .update(threadInsights)
    .set({
      needsReply: false,
      category: sql`case
        when ${threadInsights.urgency} >= 4 then 'urgent'
        when ${threadInsights.importance} >= 4 then 'important'
        when ${threadInsights.importance} >= 2 then 'informational'
        else 'low_priority'
      end::inbox_category`,
      updatedAt: new Date(),
    })
    .where(and(eq(threadInsights.threadId, threadId), eq(threadInsights.needsReply, true)));
}

export interface ThreadInsight {
  category: InboxCategory;
  urgency: number;
  importance: number;
  needsReply: boolean;
  reasons: string[];
  classifiedThroughMessageId: string;
  model: string;
  updatedAt: Date;
}

/** Not user-scoped: callers must already have verified thread ownership. */
export async function getThreadInsight(
  db: DbExecutor,
  threadId: string,
): Promise<ThreadInsight | null> {
  const [row] = await db
    .select({
      category: threadInsights.category,
      urgency: threadInsights.urgency,
      importance: threadInsights.importance,
      needsReply: threadInsights.needsReply,
      reasons: threadInsights.reasons,
      classifiedThroughMessageId: threadInsights.classifiedThroughMessageId,
      model: threadInsights.model,
      updatedAt: threadInsights.updatedAt,
    })
    .from(threadInsights)
    .where(eq(threadInsights.threadId, threadId));
  return row ?? null;
}

export interface AiUsageWrite {
  userId: string;
  mailAccountId: string | null;
  task: AiTask;
  aiProvider: AiProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export async function recordAiUsage(db: DbExecutor, input: AiUsageWrite): Promise<void> {
  await db.insert(aiUsageEvents).values(input);
}

export interface AiUsageRow {
  task: AiTask;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export async function summarizeAiUsage(
  db: DbExecutor,
  userId: string,
  since: Date,
): Promise<AiUsageRow[]> {
  return db
    .select({
      task: aiUsageEvents.task,
      model: aiUsageEvents.model,
      calls: sql<number>`count(*)`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)`.mapWith(Number),
      cacheReadTokens: sql<number>`coalesce(sum(${aiUsageEvents.cacheReadTokens}), 0)`.mapWith(
        Number,
      ),
    })
    .from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.userId, userId), gte(aiUsageEvents.createdAt, since)))
    .groupBy(aiUsageEvents.task, aiUsageEvents.model)
    .orderBy(aiUsageEvents.task, aiUsageEvents.model);
}

/**
 * Inbox threads whose last message is at or after `since`, whose newest message is not from the
 * user, that are not yet classified through that message, and whose owner has a valid key on an
 * active mailbox. Newest first.
 */
export async function listThreadsPendingClassification(
  db: DbExecutor,
  since: Date,
  limit = 200,
): Promise<Array<{ threadId: string; latestMessageId: string; credentialVersion: number }>> {
  const rows = await db.execute<{
    thread_id: string;
    latest_message_id: string;
    credential_version: string;
  }>(sql`
    select t.id as thread_id, latest.id as latest_message_id,
      (extract(epoch from c.updated_at) * 1000)::bigint as credential_version
    from ${threads} t
    join ${mailAccounts} ma on ma.id = t.mail_account_id and ma.status = 'active'
    join ${aiCredentials} c
      on c.user_id = ma.user_id and c.provider = 'anthropic' and c.status = 'valid'
    cross join lateral (
      select m.id, m.is_from_user
      from ${messages} m
      where m.thread_id = t.id
      order by m.sent_at desc, m.id desc
      limit 1
    ) latest
    left join ${threadInsights} ti on ti.thread_id = t.id
    where t.last_message_at >= ${since.toISOString()}::timestamptz
      and t.provider_labels @> array['INBOX']::text[]
      and latest.is_from_user = false
      and (ti.thread_id is null or ti.classified_through_message_id <> latest.id)
    order by t.last_message_at desc
    limit ${limit}
  `);
  return [...rows].map((r) => ({
    threadId: r.thread_id,
    latestMessageId: r.latest_message_id,
    credentialVersion: Number(r.credential_version),
  }));
}

export interface ClassificationSource {
  thread: { id: string; subject: string; mailAccountId: string; providerThreadId: string };
  userId: string;
  mailboxEmail: string;
  provider: MailProviderId;
  /** Oldest first. */
  messages: Array<typeof messages.$inferSelect>;
}

/** Worker-only (trusted id from a job payload): the thread, its owner and its messages. */
export async function getThreadForClassification(
  db: DbExecutor,
  threadId: string,
): Promise<ClassificationSource | null> {
  const [row] = await db
    .select({
      thread: {
        id: threads.id,
        subject: threads.subject,
        mailAccountId: threads.mailAccountId,
        providerThreadId: threads.providerThreadId,
      },
      userId: mailAccounts.userId,
      mailboxEmail: mailAccounts.emailAddress,
      provider: mailAccounts.provider,
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(eq(threads.id, threadId));
  if (!row) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.sentAt, messages.id);
  return { ...row, messages: rows };
}
