import { aad } from "@replywise/crypto";
import {
  completeDraft,
  failDraft,
  getDraftForWorker,
  getThreadForClassification,
  getWritingPreferences,
} from "@replywise/db";
import type { JobContext } from "@replywise/queue";
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

export type GenerateDraftDeps = Pick<GenerationDeps, "db" | "encryptor" | "ai" | "logger">;

export function generateDraftHandler(deps: GenerateDraftDeps) {
  return async (
    { draftId }: { draftId: string },
    context: JobContext = FIRST_ATTEMPT,
  ): Promise<void> => {
    try {
      await generate(deps, draftId, context);
    } catch (error) {
      await rethrowSafely(error, context, (code) => failDraft(deps.db, draftId, code));
    }
  };
}

async function generate(
  deps: GenerateDraftDeps,
  draftId: string,
  context: JobContext,
): Promise<void> {
  const draft = await getDraftForWorker(deps.db, draftId);
  if (draft?.status !== "pending") return; // deleted, discarded or already handled
  const { threadId } = draft;
  const source = await getThreadForClassification(deps.db, threadId);
  if (!source) return; // the thread (and its drafts) went away
  const key = await loadUsableKey(deps, source.userId);
  if (!key) return failDraft(deps.db, draftId, "no_ai_key");
  const prefs = await getWritingPreferences(deps.db, source.userId);
  const model = prefs.generationModel;
  const input = await buildThreadInput(deps.encryptor, source);

  let body: string;
  try {
    ({ body } = await deps.ai.draftReply(
      {
        apiKey: key.apiKey,
        model,
        onUsage: usageRecorder(deps, source, "draft", model, threadId),
      },
      {
        ...input,
        tone: draft.tone,
        instructions: draft.instructions,
        writingStyleNotes: prefs.writingStyleNotes,
        replyLanguage: prefs.replyLanguage,
      },
    ));
  } catch (error) {
    // A retryable error leaves the draft pending (completeDraft only touches pending drafts).
    return handleAiFailure(deps, error, {
      userId: source.userId,
      keyVersion: key.version,
      threadId,
      context,
      fail: (code) => failDraft(deps.db, draftId, code),
      logMessage: "draft generation failed",
    });
  }
  // The signature is not part of the stored body; it is appended when saving to Gmail.
  const write = async () => {
    const bodyCiphertext = await deps.encryptor.encrypt(body, aad.replyDraft(draftId));
    await completeDraft(deps.db, { draftId, bodyCiphertext, model });
  };
  await storePaidResult(deps, write, {
    threadId,
    fail: () => failDraft(deps.db, draftId, "internal"),
    name: "DraftWriteFailed",
    logMessage: "draft write failed",
  });
  deps.logger.info({ threadId, draftId }, "draft generated");
}
