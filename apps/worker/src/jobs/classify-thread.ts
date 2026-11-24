import { type AiProvider, CLASSIFY_PROMPT_VERSION } from "@replywise/ai";
import { deriveCategory } from "@replywise/core";
import { aad } from "@replywise/crypto";
import {
  createPendingDraft,
  failDraft,
  getAutoDraftSetting,
  getClassificationModel,
  getThreadForClassification,
  getThreadInsight,
  getWritingPreferences,
  hasDraftForMessage,
  upsertThreadInsight,
} from "@replywise/db";
import type { JobContext } from "@replywise/queue";
import { safeErrorFields } from "../log-error";
import {
  FIRST_ATTEMPT,
  type GenerationDeps,
  handleAiFailure,
  loadUsableKey,
  rethrowSafely,
  storePaidResult,
  usageRecorder,
} from "./generation-shared";
import { buildThreadInput } from "./thread-text";

/** `queue` enables auto-draft for Needs Reply; without it classification still runs. */
export type ClassifyThreadDeps = Pick<
  GenerationDeps,
  "db" | "encryptor" | "ai" | "logger" | "queue"
>;

export function classifyThreadHandler(deps: ClassifyThreadDeps) {
  return async (
    payload: { threadId: string; messageId: string },
    context: JobContext = FIRST_ATTEMPT,
  ): Promise<void> => {
    try {
      await classify(deps, payload, context);
    } catch (error) {
      await rethrowSafely(error, context);
    }
  };
}

async function classify(
  deps: ClassifyThreadDeps,
  { threadId, messageId }: { threadId: string; messageId: string },
  context: JobContext,
): Promise<void> {
  const source = await getThreadForClassification(deps.db, threadId);
  if (!source) return; // thread deleted since the scan
  const latest = source.messages.at(-1);
  if (!latest || latest.isFromUser) return;
  // A newer message has its own job; do not pay for a stale one.
  if (latest.id !== messageId) return;
  const existing = await getThreadInsight(deps.db, threadId);
  if (existing?.classifiedThroughMessageId === latest.id) return;

  const key = await loadUsableKey(deps, source.userId);
  if (!key) return;
  const model = await getClassificationModel(deps.db, source.userId);
  const input = await buildThreadInput(deps.encryptor, source);

  let result: Awaited<ReturnType<AiProvider["classify"]>>;
  try {
    result = await deps.ai.classify(
      {
        apiKey: key.apiKey,
        model,
        onUsage: usageRecorder(deps, source, "classify", model, threadId),
      },
      input,
    );
  } catch (error) {
    // No row to fail: classification has no status column.
    return handleAiFailure(deps, error, {
      userId: source.userId,
      keyVersion: key.version,
      threadId,
      context,
      fail: async () => {},
      logMessage: "classification failed",
    });
  }

  const category = deriveCategory(result);
  const insight = {
    threadId,
    category,
    urgency: result.urgency,
    importance: result.importance,
    needsReply: result.needsReply,
    reasons: result.reasons,
    classifiedThroughMessageId: latest.id,
    aiProvider: deps.ai.id,
    model,
    promptVersion: CLASSIFY_PROMPT_VERSION,
  };
  // The call is paid for: retry the write in-process rather than repeating the call via BullMQ.
  const written = await storePaidResult(deps, () => upsertThreadInsight(deps.db, insight), {
    threadId,
    name: "InsightWriteFailed",
    logMessage: "insight write failed",
  });
  if (!written) {
    // The user replied after the classified message: no insight, and no draft for it.
    deps.logger.info({ threadId }, "classification skipped (answered)");
    return;
  }
  deps.logger.info({ threadId, category }, "thread classified");

  if (result.needsReply && deps.queue) {
    // The insight is stored; a BullMQ retry would skip this thread, so log rather than throw.
    try {
      await autoDraft(deps, source.userId, source.thread.mailAccountId, threadId, latest.id);
    } catch (error) {
      deps.logger.warn({ threadId, error: safeErrorFields(error) }, "auto-draft not queued");
    }
  }
}

/** Queues one reply draft for the newest message when the mailbox opted in to auto-draft. */
async function autoDraft(
  deps: ClassifyThreadDeps,
  userId: string,
  mailAccountId: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  const { queue } = deps;
  if (!queue) return;
  if (!(await getAutoDraftSetting(deps.db, mailAccountId))) return;
  if (await hasDraftForMessage(deps.db, threadId, messageId)) return;
  const prefs = await getWritingPreferences(deps.db, userId);
  const draftId = await createPendingDraft(deps.db, {
    threadId,
    userId,
    tone: prefs.defaultTone,
    instructions: null,
    forMessageId: messageId,
    // The id (and so the real AAD) does not exist before insert. This placeholder is never
    // decrypted: readers skip pending bodies and completeDraft replaces it with the real body.
    placeholderCiphertext: await deps.encryptor.encrypt("", aad.replyDraft("pending")),
    aiProvider: deps.ai.id,
    model: prefs.generationModel,
  });
  try {
    await queue.enqueue("draft.generate", { draftId }, { jobId: `draft_${draftId}` });
  } catch (error) {
    // A pending draft with no job would block auto-draft for this message forever.
    await failDraft(deps.db, draftId, "internal");
    throw error;
  }
  deps.logger.info({ threadId, draftId }, "auto-draft queued");
}
