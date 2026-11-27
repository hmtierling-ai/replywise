import type { MailProviderId } from "@replywise/core";
import { and, count, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { replyDrafts } from "../schema/ai";
import { mailAccounts, threads } from "../schema/mail";
import { SAVE_STALE_MS } from "./generation";

/** Undo window between a confirmed send and the Gmail call (spec M6 §1). */
export const SEND_DELAY_MS = 10_000;
/** Sends per user per rolling hour: sent in the window plus scheduled/sending (spec M6 §2.3). */
export const SEND_RATE_LIMIT = 20;
export const SEND_RATE_WINDOW_MS = 60 * 60 * 1000;
/** A scheduled send this far past send_at lost its job (e.g. Redis restart): re-enqueue it. */
export const SEND_OVERDUE_MS = 60 * 1000;
/** Scheduled this far past send_at, or sending this long: give up (spec M6 §2.2 step 5). */
export const SEND_STUCK_MS = 10 * 60 * 1000;
/**
 * `error` marker set just before the Gmail send call and cleared only on a rate-limit answer.
 * A run that finds it never calls Gmail again. Never shown to users.
 */
export const SEND_ATTEMPTED = "send_attempted";
/**
 * send_failed codes that prove nothing was sent, so a new confirm may schedule again: a 4xx from
 * the send call, or an M5 save error before it. `send_unconfirmed` is deliberately absent.
 */
export const RESENDABLE_FAILURES = [
  "send_rejected",
  "gmail_reauth",
  "gmail_unavailable",
  "no_recipient",
  "internal",
] as const;

const SENDABLE = ["generated", "edited", "saved"] as const;

export interface DraftMailbox {
  threadId: string;
  mailAccountId: string;
  provider: MailProviderId;
}

export interface FailedSendRow {
  draftId: string;
  userId: string;
  threadId: string;
  mailAccountId: string;
  error: string;
}

/**
 * generated|edited|saved (or send_failed with a resendable code) → scheduled. Refused while a
 * non-stale save to Gmail is in flight and for non-Gmail mailboxes. Enqueue only on true.
 * `expectedCiphertext` is the body the caller checked against the confirmation: encryption is
 * randomised, so any re-save since then changes the bytes and the update does not apply.
 */
export async function scheduleSend(
  db: DbExecutor,
  userId: string,
  draftId: string,
  expectedCiphertext: Buffer,
  sendAt: Date,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "scheduled", sendAt, error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        eq(replyDrafts.bodyCiphertext, expectedCiphertext),
        or(
          inArray(replyDrafts.status, [...SENDABLE]),
          and(
            eq(replyDrafts.status, "send_failed"),
            inArray(replyDrafts.error, [...RESENDABLE_FAILURES]),
          ),
        ),
        or(
          isNull(replyDrafts.saveRequestedAt),
          lt(replyDrafts.saveRequestedAt, new Date(now.getTime() - SAVE_STALE_MS)),
        ),
        sql`exists (
          select 1 from ${threads} t
          join ${mailAccounts} ma on ma.id = t.mail_account_id
          where t.id = ${replyDrafts.threadId} and ma.user_id = ${userId} and ma.provider = 'gmail'
        )`,
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/**
 * scheduled → edited. Returns the send_at it had (send_at is kept, so the caller can compute the
 * delayed job id to remove), or null when the draft was not scheduled (already claimed: too late).
 */
export async function undoSend(
  db: DbExecutor,
  userId: string,
  draftId: string,
  now: Date,
): Promise<{ sendAt: Date | null } | null> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "edited", updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        eq(replyDrafts.status, "scheduled"),
      ),
    )
    .returning({ sendAt: replyDrafts.sendAt });
  const row = rows[0];
  return row ? { sendAt: row.sendAt } : null;
}

/** Worker-only. scheduled → sending, only once the undo window is over. */
export async function claimSend(db: DbExecutor, draftId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "sending", error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.status, "scheduled"),
        lte(replyDrafts.sendAt, now),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** Worker-only. False when another run already marked it: that run owns the Gmail call. */
export async function markSendAttempted(db: DbExecutor, draftId: string): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ error: SEND_ATTEMPTED })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.status, "sending"),
        isNull(replyDrafts.error),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** Worker-only. Gmail answered with a rate limit: the request was not processed. */
export async function clearSendAttempted(db: DbExecutor, draftId: string): Promise<void> {
  await db
    .update(replyDrafts)
    .set({ error: null })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.status, "sending"),
        eq(replyDrafts.error, SEND_ATTEMPTED),
      ),
    );
}

/**
 * Worker-only. Keeps the Gmail draft id so a retry updates that draft instead of adding one.
 * A no-op once the send was attempted: the draft being sent must never be repointed.
 */
export async function recordSendDraftId(
  db: DbExecutor,
  draftId: string,
  providerDraftId: string,
): Promise<void> {
  await db
    .update(replyDrafts)
    .set({ providerDraftId })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.status, "sending"),
        isNull(replyDrafts.error),
      ),
    );
}

/** Worker-only. sending → sent. */
export async function markSent(
  db: DbExecutor,
  draftId: string,
  providerMessageId: string,
  sentAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "sent", sentAt, providerMessageId, error: null, updatedAt: sentAt })
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "sending")))
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** Worker-only. sending → send_failed with a fixed code. */
export async function failSend(db: DbExecutor, draftId: string, error: string): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "send_failed", error, updatedAt: new Date() })
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "sending")))
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/**
 * Worker-only. sending → send_failed for a failure before the Gmail send call. False (no-op) once
 * any run has marked the attempt: that run owns the outcome, and a resendable code written over
 * an in-flight or finished send would let the user send the reply twice.
 */
export async function failSendBeforeAttempt(
  db: DbExecutor,
  draftId: string,
  error: string,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "send_failed", error, updatedAt: new Date() })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.status, "sending"),
        isNull(replyDrafts.error),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/**
 * Worker-only. Gmail confirmed the send but the row was failed meanwhile (stuck scan or a losing
 * run): send_failed → sent, so it can never be scheduled again. Never touches a row the user has
 * already reopened or re-confirmed.
 */
export async function markSentAfterFailure(
  db: DbExecutor,
  draftId: string,
  providerMessageId: string,
  sentAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "sent", sentAt, providerMessageId, error: null, updatedAt: sentAt })
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "send_failed")))
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** The user's "Edit" on a failed send: send_failed → edited (acknowledges send_unconfirmed). */
export async function reopenFailedSend(
  db: DbExecutor,
  userId: string,
  draftId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "edited", error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        eq(replyDrafts.status, "send_failed"),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

export async function countRecentSends(db: DbExecutor, userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.userId, userId),
        or(
          gte(replyDrafts.sentAt, new Date(now.getTime() - SEND_RATE_WINDOW_MS)),
          inArray(replyDrafts.status, ["scheduled", "sending"]),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** A draft of this thread is scheduled or sending: no regenerate while it runs. */
export async function hasActiveSend(
  db: DbExecutor,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: replyDrafts.id })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.threadId, threadId),
        eq(replyDrafts.userId, userId),
        inArray(replyDrafts.status, ["scheduled", "sending"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function getDraftMailbox(
  db: DbExecutor,
  userId: string,
  draftId: string,
): Promise<DraftMailbox | null> {
  const [row] = await db
    .select({
      threadId: threads.id,
      mailAccountId: mailAccounts.id,
      provider: mailAccounts.provider,
    })
    .from(replyDrafts)
    .innerJoin(threads, eq(replyDrafts.threadId, threads.id))
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        eq(mailAccounts.userId, userId),
      ),
    );
  return row ?? null;
}

/** Worker-only. Scheduled sends whose job seems lost, not yet old enough to expire. */
export async function listOverdueScheduledSends(
  db: DbExecutor,
  now: Date,
  limit = 100,
): Promise<Array<{ draftId: string; sendAt: Date }>> {
  const rows = await db
    .select({ draftId: replyDrafts.id, sendAt: replyDrafts.sendAt })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.status, "scheduled"),
        lt(replyDrafts.sendAt, new Date(now.getTime() - SEND_OVERDUE_MS)),
        gte(replyDrafts.sendAt, new Date(now.getTime() - SEND_STUCK_MS)),
      ),
    )
    .orderBy(replyDrafts.sendAt)
    .limit(limit);
  return rows.flatMap((r) => (r.sendAt ? [{ draftId: r.draftId, sendAt: r.sendAt }] : []));
}

async function failWhere(
  db: DbExecutor,
  condition: SQL,
  error: string,
  now: Date,
): Promise<FailedSendRow[]> {
  const rows = await db.execute<{
    id: string;
    user_id: string;
    thread_id: string;
    mail_account_id: string;
  }>(sql`
    update ${replyDrafts} as d
    set status = 'send_failed', error = ${error}, updated_at = ${now.toISOString()}::timestamptz
    from ${threads} t
    where t.id = d.thread_id and ${condition}
    returning d.id, d.user_id, d.thread_id, t.mail_account_id
  `);
  return [...rows].map((r) => ({
    draftId: r.id,
    userId: r.user_id,
    threadId: r.thread_id,
    mailAccountId: r.mail_account_id,
    error,
  }));
}

/** Worker-only. Never claimed within SEND_STUCK_MS of send_at: nothing reached Gmail. */
export function expireScheduledSends(db: DbExecutor, now: Date): Promise<FailedSendRow[]> {
  const cutoff = new Date(now.getTime() - SEND_STUCK_MS).toISOString();
  return failWhere(
    db,
    sql`d.status = 'scheduled' and d.send_at < ${cutoff}::timestamptz`,
    "internal",
    now,
  );
}

/** Worker-only. Sending for over SEND_STUCK_MS: it may or may not have gone out; never re-sent. */
export function failStuckSends(db: DbExecutor, now: Date): Promise<FailedSendRow[]> {
  const cutoff = new Date(now.getTime() - SEND_STUCK_MS).toISOString();
  return failWhere(
    db,
    sql`d.status = 'sending' and d.updated_at < ${cutoff}::timestamptz`,
    "send_unconfirmed",
    now,
  );
}
