import { aad } from "@replywise/crypto";
import {
  type ClassificationSource,
  type DraftRow,
  failDraftSave,
  getDraftForWorker,
  getThreadForClassification,
  getWritingPreferences,
  insertAuditLog,
  markDraftSaved,
  recordProviderDraftId,
  SAVE_STALE_MS,
} from "@replywise/db";
import {
  buildReplyMime,
  type GmailDraftsApi,
  type GmailDraftsFactory,
  ProviderHttpError,
  toBase64Url,
} from "@replywise/mail";
import {
  getValidAccessToken,
  MailAccountNotFoundError,
  type MailboxDeps,
  ReauthRequiredError,
} from "@replywise/mailbox";
import type { JobContext } from "@replywise/queue";
import { UnrecoverableError } from "bullmq";
import { safeErrorFields } from "../log-error";
import { errorCode, isRetryableGmailError } from "./generation-errors";
import {
  FIRST_ATTEMPT,
  type GenerationDeps,
  isFinalAttempt,
  rethrowSafely,
  withWriteRetries,
} from "./generation-shared";

export type SaveDraftDeps = Pick<GenerationDeps, "db" | "encryptor" | "logger"> & {
  gmailDrafts: GmailDraftsFactory;
  mailbox: MailboxDeps;
};

const SAVEABLE = new Set<DraftRow["status"]>(["generated", "edited", "saved"]);

/** Writes the reply into the user's Gmail drafts. Drafts only: nothing is ever delivered. */
export function saveDraftHandler(deps: SaveDraftDeps) {
  return async (
    { draftId }: { draftId: string },
    context: JobContext = FIRST_ATTEMPT,
  ): Promise<void> => {
    try {
      await save(deps, draftId, context);
    } catch (error) {
      await rethrowSafely(error, context, (code) => failDraftSave(deps.db, draftId, code));
    }
  };
}

async function save(deps: SaveDraftDeps, draftId: string, context: JobContext): Promise<void> {
  const draft = await getDraftForWorker(deps.db, draftId);
  if (!draft || !SAVEABLE.has(draft.status) || !draft.saveRequestedAt) return;
  // A stale request no longer blocks a new one, so acting on it could race a newer save.
  if (Date.now() - draft.saveRequestedAt.getTime() > SAVE_STALE_MS) {
    deps.logger.info({ draftId }, "stale save request skipped");
    return;
  }
  const source = await getThreadForClassification(deps.db, draft.threadId);
  if (!source) return; // the thread (and its drafts) went away

  const target = replyTarget(draft, source);
  if (!target) return failDraftSave(deps.db, draftId, "no_recipient");

  /** Fails the save with a fixed code and stops retries. */
  const giveUp = async (error: unknown): Promise<never> => {
    // Best effort: a DB error here must not become retryable and re-run createDraft.
    await failDraftSave(deps.db, draftId, errorCode(error)).catch(() => undefined);
    deps.logger.warn(
      { threadId: source.thread.id, draftId, error: safeErrorFields(error) },
      "draft save failed",
    );
    throw new UnrecoverableError(error instanceof Error ? error.name : "Error");
  };

  let raw: string;
  try {
    const body = await deps.encryptor.decryptString(draft.bodyCiphertext, aad.replyDraft(draftId));
    const { signature } = await getWritingPreferences(deps.db, source.userId);
    raw = toBase64Url(
      buildReplyMime({
        from: { name: null, address: source.mailboxEmail },
        to: target.fromAddress,
        subject: source.thread.subject,
        inReplyTo: target.internetMessageId,
        references: source.messages
          .map((m) => m.internetMessageId)
          .filter((id): id is string => Boolean(id)),
        body: signature ? `${body}\n\n${signature}` : body,
      }),
    );
  } catch (error) {
    if (errorCode(error) === "no_recipient") return giveUp(error);
    throw error;
  }

  let api: GmailDraftsApi;
  try {
    // Outside any transaction: a token refresh may call the provider.
    const { accessToken } = await getValidAccessToken(deps.mailbox, source.thread.mailAccountId);
    api = deps.gmailDrafts(accessToken);
  } catch (error) {
    if (error instanceof ReauthRequiredError || error instanceof MailAccountNotFoundError) {
      return giveUp(error);
    }
    throw error;
  }

  /** Keeps saveRequestedAt for a BullMQ retry; only the final attempt fails the save. */
  const retryLater = async (error: ProviderHttpError): Promise<never> => {
    if (isFinalAttempt(context)) await failDraftSave(deps.db, draftId, errorCode(error));
    throw error;
  };

  const threadId = source.thread.providerThreadId;
  let updated: { draftId: string } | null = null;
  if (draft.providerDraftId) {
    try {
      // PUT is idempotent: transient failures may be retried.
      updated = await api.updateDraft(draft.providerDraftId, { raw, threadId });
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      if (!isRetryableGmailError(error)) return giveUp(error);
      return retryLater(error);
    }
  }
  let providerDraftId: string;
  if (updated) {
    providerDraftId = updated.draftId;
  } else {
    try {
      ({ draftId: providerDraftId } = await api.createDraft({ raw, threadId }));
    } catch (error) {
      // POST is not idempotent: after a timeout, 5xx or anything else Gmail may already hold the
      // draft, so only a rate limit (request not processed) is retried.
      if (error instanceof ProviderHttpError && error.rateLimited) return retryLater(error);
      return giveUp(error);
    }
  }

  // Gmail now holds the draft: record it in-process rather than repeating the call via BullMQ.
  let recorded: boolean;
  try {
    recorded = await withWriteRetries(() =>
      markDraftSaved(deps.db, draftId, providerDraftId, new Date()),
    );
  } catch (error) {
    deps.logger.warn(
      { threadId: source.thread.id, draftId, error: safeErrorFields(error) },
      "draft save not recorded",
    );
    // Keep at least the Gmail id, so the next save updates that draft instead of adding one.
    await recordProviderDraftId(deps.db, draftId, providerDraftId).catch(() => undefined);
    await failDraftSave(deps.db, draftId, "internal").catch(() => undefined);
    throw new UnrecoverableError("DraftRecordFailed");
  }
  if (!recorded) {
    deps.logger.info({ draftId }, "draft discarded during save");
    return;
  }
  await insertAuditLog(deps.db, {
    userId: source.userId,
    action: "draft.saved",
    targetType: "reply_draft",
    targetId: draftId,
    metadata: { provider: "gmail" },
  }).catch((error: unknown) => {
    deps.logger.warn({ draftId, error: safeErrorFields(error) }, "audit entry not written");
  });
  deps.logger.info({ threadId: source.thread.id, draftId }, "draft saved to gmail");
}

/** The message being answered: the one the draft was made for, else the newest from someone else. */
function replyTarget(draft: DraftRow, source: ClassificationSource) {
  // Never answer one of the user's own messages.
  const chosen = draft.forMessageId
    ? source.messages.find((m) => m.id === draft.forMessageId && !m.isFromUser)
    : undefined;
  return chosen ?? source.messages.findLast((m) => !m.isFromUser) ?? null;
}
