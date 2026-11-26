import {
  claimSend,
  clearSendAttempted,
  failSend,
  getDraftForWorker,
  getThreadForClassification,
  markSendAttempted,
  markSent,
  markThreadAnswered,
  recordSendDraftId,
  SEND_DELAY_MS,
} from "@replywise/db";
import { type GmailSendFactory, ProviderHttpError } from "@replywise/mail";
import { createGmailSendApi } from "@replywise/mail/gmail-send";
import { getValidAccessToken } from "@replywise/mailbox";
import type { JobContext, JobQueue } from "@replywise/queue";
import { UnrecoverableError } from "bullmq";
import { safeErrorFields, sanitizeError } from "../log-error";
import { errorCode } from "./generation-errors";
import { FIRST_ATTEMPT, isFinalAttempt, withWriteRetries } from "./generation-shared";
import { buildDraftRaw, writeGmailDraft } from "./gmail-draft-write";
import type { SaveDraftDeps } from "./save-draft";
import { writeSendAudit } from "./send-audit";

export type SendDraftDeps = SaveDraftDeps & {
  queue: JobQueue;
  /** Tests inject a fake. Production builds the one real send client here and nowhere else. */
  gmailSend?: GmailSendFactory;
};

/** A delayed job can fire a little early: wait at most this long for the undo window to end. */
const MAX_EARLY_MS = SEND_DELAY_MS + 5_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delivers one reply the user confirmed (spec M6 §2.2): claim → write the Gmail draft (M5 code) →
 * mark the attempt → Gmail's send-draft call → record. Only rate limits are retried. Once the send
 * call may have reached Gmail, nothing repeats it.
 */
export function sendDraftHandler(deps: SendDraftDeps) {
  const senderFor: GmailSendFactory =
    deps.gmailSend ?? ((accessToken) => createGmailSendApi(accessToken));
  return async (
    { draftId }: { draftId: string },
    context: JobContext = FIRST_ATTEMPT,
  ): Promise<void> => {
    try {
      if (!(await claim(deps, draftId))) return;
      await deliver(deps, senderFor, draftId, context);
    } catch (error) {
      // UnrecoverableError ends the job; rate limits are retried by BullMQ. Any other error
      // happened before the send call (deliver turns every later failure into an
      // UnrecoverableError), so a sanitized retry is safe and resumes the claimed row.
      if (error instanceof UnrecoverableError || error instanceof ProviderHttpError) throw error;
      throw sanitizeError(error);
    }
  };
}

/** True when this run owns the send: it claimed the row, or resumes a claim that never sent. */
async function claim(deps: SendDraftDeps, draftId: string): Promise<boolean> {
  if (await claimSend(deps.db, draftId, new Date())) return true;
  const draft = await getDraftForWorker(deps.db, draftId);
  if (draft?.status === "scheduled" && draft.sendAt) {
    const wait = draft.sendAt.getTime() - Date.now();
    if (wait > 0 && wait <= MAX_EARLY_MS) {
      await sleep(wait);
      return claimSend(deps.db, draftId, new Date());
    }
    return false;
  }
  // `sending` with no marker: an earlier run stopped before the send call. With the marker the
  // send may have happened, so it is never resumed (the stuck scan fails it as unconfirmed).
  return draft?.status === "sending" && draft.error === null;
}

async function deliver(
  deps: SendDraftDeps,
  senderFor: GmailSendFactory,
  draftId: string,
  context: JobContext,
): Promise<void> {
  const draft = await getDraftForWorker(deps.db, draftId);
  // Re-checked: a concurrent run (e.g. a stalled job taken over) may have marked it meanwhile.
  if (draft?.status !== "sending" || draft.error !== null) return;
  const source = await getThreadForClassification(deps.db, draft.threadId);
  if (!source) return; // the thread is gone, and its drafts with it
  const meta = { draftId, threadId: source.thread.id, mailAccountId: source.thread.mailAccountId };

  /** Ends the send with a fixed code. Never retried. */
  const stop = async (code: string, error?: unknown): Promise<never> => {
    await failSend(deps.db, draftId, code).catch(() => undefined);
    await writeSendAudit(deps, source.userId, "draft.send_failed", { ...meta, error: code });
    deps.logger.warn(
      { ...meta, code, ...(error === undefined ? {} : { error: safeErrorFields(error) }) },
      "draft send failed",
    );
    throw new UnrecoverableError(code);
  };

  // Gmail only: never another provider's API.
  if (source.provider !== "gmail") return stop("internal");

  // 1. The Gmail draft must hold exactly this body. Nothing has been sent yet: a rate limit is
  //    retried, any other failure ends the send with the M5 save error code.
  let accessToken: string;
  let providerDraftId: string;
  try {
    const raw = await buildDraftRaw(deps, draft, source);
    // Outside any transaction: a token refresh may call the provider.
    ({ accessToken } = await getValidAccessToken(deps.mailbox, source.thread.mailAccountId));
    const written = await writeGmailDraft(deps.gmailDrafts(accessToken), draft.providerDraftId, {
      raw,
      threadId: source.thread.providerThreadId,
    });
    providerDraftId = written;
    if (written !== draft.providerDraftId) {
      await withWriteRetries(() => recordSendDraftId(deps.db, draftId, written));
    }
  } catch (error) {
    if (error instanceof ProviderHttpError && error.rateLimited) {
      if (isFinalAttempt(context)) return stop("gmail_unavailable", error);
      throw error;
    }
    return stop(errorCode(error), error);
  }

  // 2. Mark first, so no later or concurrent run can ever repeat the send call.
  if (!(await markSendAttempted(deps.db, draftId))) {
    deps.logger.info({ draftId }, "draft send already attempted");
    return;
  }
  let messageId: string;
  try {
    const sender = senderFor(accessToken);
    ({ messageId } = await sender.sendDraft(providerDraftId));
  } catch (error) {
    if (error instanceof ProviderHttpError && error.rateLimited) {
      // Gmail did not process the request, so it may be repeated.
      try {
        await clearSendAttempted(deps.db, draftId);
      } catch {
        // The marker stays: the stuck scan fails the row as unconfirmed, never re-sends.
        throw new UnrecoverableError("SendMarkerNotCleared");
      }
      if (isFinalAttempt(context)) return stop("gmail_unavailable", error);
      throw error;
    }
    const rejected =
      error instanceof ProviderHttpError && error.status >= 400 && error.status < 500;
    return stop(rejected ? "send_rejected" : "send_unconfirmed", error);
  }

  // 3. Gmail accepted it. Record in-process: a BullMQ retry would send again.
  let recorded: boolean;
  try {
    recorded = await withWriteRetries(() => markSent(deps.db, draftId, messageId, new Date()));
  } catch (error) {
    deps.logger.warn({ ...meta, error: safeErrorFields(error) }, "draft send not recorded");
    throw new UnrecoverableError("SendRecordFailed");
  }
  if (!recorded) {
    // The stuck scan failed the row while the call ran. The reply did go out.
    deps.logger.warn(meta, "draft sent but the row was no longer sending");
  }
  await markThreadAnswered(deps.db, source.thread.id).catch((error: unknown) => {
    deps.logger.warn({ ...meta, error: safeErrorFields(error) }, "thread not marked answered");
  });
  await writeSendAudit(deps, source.userId, "draft.sent", meta);
  await deps.queue
    .enqueue(
      "mailbox.sync",
      { mailAccountId: source.thread.mailAccountId },
      { jobId: `sync_after_send_${draftId}` },
    )
    .catch((error: unknown) => {
      deps.logger.warn({ ...meta, error: safeErrorFields(error) }, "sync after send not queued");
    });
  deps.logger.info({ threadId: source.thread.id, draftId }, "draft sent");
}
