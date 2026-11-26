import { type AiProviderId, DEFAULT_AI_MODELS, type ReplyTone } from "@replywise/core";
import { and, desc, eq, gte, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { replyDrafts, threadSummaries, userPreferences } from "../schema/ai";
import { mailAccounts, messages, threads } from "../schema/mail";

export interface ThreadSummary {
  status: "pending" | "ready" | "failed";
  summary: string | null;
  throughMessageId: string | null;
  model: string | null;
  error: string | null;
  requestedAt: Date;
  updatedAt: Date;
}

/**
 * Worker-only (trusted ids): callers must verify thread ownership first.
 * Marks a summary as pending (keeps the previous text so the UI can show it while refreshing).
 */
export async function requestSummary(
  db: DbExecutor,
  threadId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - PENDING_STALE_MS);
  // Refused (false, nothing written) while a fresh pending request exists. Enqueue only on true.
  const rows = await db
    .insert(threadSummaries)
    .values({ threadId, status: "pending", requestedAt: now })
    .onConflictDoUpdate({
      target: threadSummaries.threadId,
      set: { status: "pending", error: null, requestedAt: now, updatedAt: now },
      setWhere: or(ne(threadSummaries.status, "pending"), lt(threadSummaries.requestedAt, cutoff)),
    })
    .returning({ threadId: threadSummaries.threadId });
  return rows.length > 0;
}

/** A pending summary or draft older than this is treated as stuck: it no longer blocks retries. */
export const PENDING_STALE_MS = 5 * 60 * 1000;

/** True when a non-stale pending draft exists for this thread (user-scoped). */
export async function hasFreshPendingDraft(
  db: DbExecutor,
  userId: string,
  threadId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: replyDrafts.id })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.threadId, threadId),
        eq(replyDrafts.userId, userId),
        eq(replyDrafts.status, "pending"),
        gte(replyDrafts.createdAt, new Date(now.getTime() - PENDING_STALE_MS)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Worker-only (trusted ids). Only acts on a pending summary. */
export async function completeSummary(
  db: DbExecutor,
  input: { threadId: string; summary: string; throughMessageId: string; model: string },
): Promise<void> {
  await db
    .update(threadSummaries)
    .set({
      status: "ready",
      summary: input.summary,
      throughMessageId: input.throughMessageId,
      model: input.model,
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(threadSummaries.threadId, input.threadId), eq(threadSummaries.status, "pending")),
    );
}

/**
 * Worker-only (trusted ids). Only acts on a pending summary, so a best-effort failure write can
 * never flip a ready summary to failed.
 */
export async function failSummary(db: DbExecutor, threadId: string, error: string): Promise<void> {
  await db
    .update(threadSummaries)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(and(eq(threadSummaries.threadId, threadId), eq(threadSummaries.status, "pending")));
}

/** Worker-only (trusted ids). Not user-scoped: callers must verify thread ownership first. */
export async function getSummary(db: DbExecutor, threadId: string): Promise<ThreadSummary | null> {
  const [row] = await db
    .select({
      status: threadSummaries.status,
      summary: threadSummaries.summary,
      throughMessageId: threadSummaries.throughMessageId,
      model: threadSummaries.model,
      error: threadSummaries.error,
      requestedAt: threadSummaries.requestedAt,
      updatedAt: threadSummaries.updatedAt,
    })
    .from(threadSummaries)
    .where(eq(threadSummaries.threadId, threadId));
  return row ?? null;
}

export type DraftRow = typeof replyDrafts.$inferSelect;

/**
 * Throws `thread_not_owned` when the thread does not belong to `userId`. `forMessageId` must
 * belong to the same thread (not validated here).
 */
export async function createPendingDraft(
  db: DbExecutor,
  input: {
    threadId: string;
    userId: string;
    tone: ReplyTone;
    instructions: string | null;
    forMessageId: string | null;
    /** Encrypted empty body; the real body replaces it when generation completes. */
    placeholderCiphertext: Buffer;
    aiProvider: AiProviderId;
    model: string;
  },
): Promise<string> {
  // Insert only when the thread belongs to input.userId (single statement, no check-then-act).
  const rows = await db.execute<{ id: string }>(sql`
    insert into reply_drafts
      (thread_id, user_id, tone, instructions, for_message_id, body_ciphertext, status, ai_provider, model)
    select ${input.threadId}::uuid, ${input.userId}, ${input.tone}::reply_tone, ${input.instructions},
      ${input.forMessageId}::uuid, ${input.placeholderCiphertext}::bytea, 'pending'::draft_status,
      ${input.aiProvider}::ai_provider, ${input.model}
    where exists (
      select 1 from ${threads} t
      join ${mailAccounts} ma on ma.id = t.mail_account_id
      where t.id = ${input.threadId}::uuid and ma.user_id = ${input.userId}
    )
    returning id
  `);
  const row = [...rows][0];
  if (!row) throw new Error("thread_not_owned");
  return row.id;
}

export async function completeDraft(
  db: DbExecutor,
  input: { draftId: string; bodyCiphertext: Buffer; model: string },
): Promise<void> {
  await db
    .update(replyDrafts)
    .set({
      bodyCiphertext: input.bodyCiphertext,
      status: "generated",
      model: input.model,
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(replyDrafts.id, input.draftId), eq(replyDrafts.status, "pending")));
}

export async function failDraft(db: DbExecutor, draftId: string, error: string): Promise<void> {
  await db
    .update(replyDrafts)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "pending")));
}

/** Worker-only (trusted ids): not user-scoped. */
export async function getDraftForWorker(db: DbExecutor, draftId: string): Promise<DraftRow | null> {
  const [row] = await db.select().from(replyDrafts).where(eq(replyDrafts.id, draftId));
  return row ?? null;
}

export async function getDraftForUser(
  db: DbExecutor,
  userId: string,
  draftId: string,
): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(replyDrafts)
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.userId, userId)));
  return row ?? null;
}

/** Newest first, excluding discarded drafts. */
export async function listDraftsForThread(
  db: DbExecutor,
  userId: string,
  threadId: string,
): Promise<DraftRow[]> {
  return db
    .select()
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.threadId, threadId),
        eq(replyDrafts.userId, userId),
        ne(replyDrafts.status, "discarded"),
      ),
    )
    .orderBy(desc(replyDrafts.createdAt));
}

const EDITABLE = sql`${replyDrafts.status} in ('generated', 'edited', 'saved')`;

/**
 * A save request older than this is treated as abandoned (lost enqueue, stalled job, failed
 * cleanup): it no longer blocks edits or new requests, and the worker will not act on it.
 */
export const SAVE_STALE_MS = 10 * 60 * 1000;

/** No save in flight: never requested, or the request is stale. */
function noSaveInFlight(now: Date) {
  return or(
    isNull(replyDrafts.saveRequestedAt),
    lt(replyDrafts.saveRequestedAt, new Date(now.getTime() - SAVE_STALE_MS)),
  );
}

/** Rejected (false) while a (non-stale) save to Gmail is in flight. */
export async function updateDraftBody(
  db: DbExecutor,
  userId: string,
  draftId: string,
  bodyCiphertext: Buffer,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ bodyCiphertext, status: "edited", error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        EDITABLE,
        noSaveInFlight(now),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/**
 * Refused (false) while an earlier, non-stale save is still in flight, so one draft never saves
 * twice at once. Enqueue `draft.save` only on true.
 */
export async function requestDraftSave(
  db: DbExecutor,
  userId: string,
  draftId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ saveRequestedAt: now, error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        EDITABLE,
        noSaveInFlight(now),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** False when the draft left the editable states (e.g. discarded) while the save ran. */
export async function markDraftSaved(
  db: DbExecutor,
  draftId: string,
  providerDraftId: string,
  savedAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({
      status: "saved",
      providerDraftId,
      savedAt,
      saveRequestedAt: null,
      error: null,
      updatedAt: savedAt,
    })
    .where(and(eq(replyDrafts.id, draftId), EDITABLE))
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/**
 * Worker-only (trusted ids). Minimal fallback when markDraftSaved cannot be written: keeps the
 * Gmail draft id so the next save updates that draft instead of creating a second one.
 */
export async function recordProviderDraftId(
  db: DbExecutor,
  draftId: string,
  providerDraftId: string,
): Promise<void> {
  await db
    .update(replyDrafts)
    .set({ providerDraftId })
    .where(and(eq(replyDrafts.id, draftId), EDITABLE));
}

export async function failDraftSave(db: DbExecutor, draftId: string, error: string): Promise<void> {
  await db
    .update(replyDrafts)
    .set({ saveRequestedAt: null, error, updatedAt: new Date() })
    .where(and(eq(replyDrafts.id, draftId), EDITABLE));
}

/**
 * Discarding a pending draft makes a later completeDraft a no-op. Refused (false) while a
 * non-stale save to Gmail is in flight, so a discard never races the worker.
 */
export async function discardDraft(
  db: DbExecutor,
  userId: string,
  draftId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "discarded", updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        noSaveInFlight(now),
        // A confirmed send is in flight or done: the draft is locked (spec M6 §2.1).
        notInArray(replyDrafts.status, ["scheduled", "sending", "sent"]),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/**
 * Worker-only (trusted ids). Auto-draft dedupe: any draft answering this message that is not
 * discarded or failed (failed ones may be retried).
 */
export async function hasDraftForMessage(
  db: DbExecutor,
  threadId: string,
  messageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: replyDrafts.id })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.threadId, threadId),
        eq(replyDrafts.forMessageId, messageId),
        notInArray(replyDrafts.status, ["discarded", "failed"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export interface WritingPreferences {
  defaultTone: ReplyTone;
  signature: string;
  writingStyleNotes: string;
  /** null = reply in the language of the email. */
  replyLanguage: string | null;
  generationModel: string;
}

export async function getWritingPreferences(
  db: DbExecutor,
  userId: string,
): Promise<WritingPreferences> {
  const [row] = await db
    .select({
      defaultTone: userPreferences.defaultTone,
      signature: userPreferences.signature,
      writingStyleNotes: userPreferences.writingStyleNotes,
      replyLanguage: userPreferences.replyLanguage,
      generationModel: userPreferences.generationModel,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return (
    row ?? {
      defaultTone: "professional",
      signature: "",
      writingStyleNotes: "",
      replyLanguage: null,
      generationModel: DEFAULT_AI_MODELS.generation,
    }
  );
}

export async function setWritingPreferences(
  db: DbExecutor,
  userId: string,
  prefs: Partial<WritingPreferences>,
): Promise<void> {
  await db
    .insert(userPreferences)
    .values({ userId, ...prefs })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { ...prefs, updatedAt: new Date() },
    });
}

/** Worker-only. */
export async function getAutoDraftSetting(db: DbExecutor, mailAccountId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: mailAccounts.autoDraftNeedsReply })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, mailAccountId));
  return row?.enabled ?? false;
}

export async function setAutoDraft(
  db: DbExecutor,
  userId: string,
  mailAccountId: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await db
    .update(mailAccounts)
    .set({ autoDraftNeedsReply: enabled, updatedAt: new Date() })
    .where(and(eq(mailAccounts.id, mailAccountId), eq(mailAccounts.userId, userId)))
    .returning({ id: mailAccounts.id });
  return rows.length > 0;
}

/** Newest message in the thread not sent by the user (user-scoped via the mailbox owner), or null. */
export async function latestInboundMessageId(
  db: DbExecutor,
  userId: string,
  threadId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(mailAccounts.userId, userId),
        eq(messages.isFromUser, false),
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(1);
  return row?.id ?? null;
}

export async function threadBelongsToUser(
  db: DbExecutor,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(and(eq(threads.id, threadId), eq(mailAccounts.userId, userId)));
  return Boolean(row);
}
