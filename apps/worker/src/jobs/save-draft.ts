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
} from "@replywise/db";
import {
  buildReplyMime,
  type GmailDraftsApi,
  type GmailDraftsFactory,
  ProviderHttpError,
  toBase64Url,
} from "@replywise/mail";
import { getValidAccessToken, type MailboxDeps } from "@replywise/mailbox";
import type { JobContext } from "@replywise/queue";
import { UnrecoverableError } from "bullmq";
import { safeErrorFields } from "../log-error";
import { errorCode, isRetryableGmailError } from "./generation-errors";
import {
  FIRST_ATTEMPT,
  type GenerationDeps,
  isFinalAttempt,
  rethrowSafely,
} from "./generation-shared";

export type SaveDraftDeps = Pick<GenerationDeps, "db" | "encryptor" | "logger"> & {
  gmailDrafts: GmailDraftsFactory;
  mailbox: MailboxDeps;
};

const SAVEABLE = new Set<DraftRow["status"]>(["generated", "edited", "saved"]);
const RECORD_TRIES = 3;
const RECORD_BASE_DELAY_MS = 200;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const source = await getThreadForClassification(deps.db, draft.threadId);
  if (!source) return; // the thread (and its drafts) went away

  const target = replyTarget(draft, source);
  if (!target) return failDraftSave(deps.db, draftId, "no_recipient");

  /** Fails the save with a fixed code and stops retries. */
  const giveUp = async (error: unknown): Promise<never> => {
    await failDraftSave(deps.db, draftId, errorCode(error));
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
    if (errorCode(error) === "gmail_reauth") return giveUp(error);
    throw error;
  }

  const threadId = source.thread.providerThreadId;
  let providerDraftId: string;
  try {
    const updated = draft.providerDraftId
      ? await api.updateDraft(draft.providerDraftId, { raw, threadId })
      : null;
    if (updated) {
      providerDraftId = updated.draftId;
    } else {
      try {
        ({ draftId: providerDraftId } = await api.createDraft({ raw, threadId }));
      } catch (error) {
        // A timed-out create may still have created the draft: retrying could duplicate it.
        if (error instanceof ProviderHttpError && error.status === 0) return giveUp(error);
        throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof ProviderHttpError)) throw error;
    if (!isRetryableGmailError(error)) return giveUp(error);
    // Keep saveRequestedAt until the final attempt; BullMQ retries with backoff.
    if (isFinalAttempt(context)) await failDraftSave(deps.db, draftId, errorCode(error));
    throw error;
  }

  // Gmail now holds the draft: record it in-process rather than repeating the call via BullMQ.
  for (let attempt = 1; ; attempt++) {
    try {
      await markDraftSaved(deps.db, draftId, providerDraftId, new Date());
      break;
    } catch (error) {
      if (attempt >= RECORD_TRIES) {
        deps.logger.warn(
          { threadId: source.thread.id, draftId, error: safeErrorFields(error) },
          "draft save not recorded",
        );
        await failDraftSave(deps.db, draftId, "internal").catch(() => undefined);
        throw new UnrecoverableError("DraftRecordFailed");
      }
      await sleep(RECORD_BASE_DELAY_MS * attempt);
    }
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
  const chosen = draft.forMessageId
    ? source.messages.find((m) => m.id === draft.forMessageId)
    : undefined;
  return chosen ?? source.messages.findLast((m) => !m.isFromUser) ?? null;
}
