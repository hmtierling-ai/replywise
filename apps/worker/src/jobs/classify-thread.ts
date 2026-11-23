import {
  AiKeyInvalidError,
  type AiProvider,
  CLASSIFY_PROMPT_VERSION,
  isRetryableAiError,
} from "@replywise/ai";
import { deriveCategory } from "@replywise/core";
import { aad, type Encryptor } from "@replywise/crypto";
import {
  type Db,
  getAiCredentialForUse,
  getClassificationModel,
  getThreadForClassification,
  getThreadInsight,
  markAiCredentialInvalid,
  recordAiUsage,
  upsertThreadInsight,
} from "@replywise/db";
import type { Logger } from "@replywise/observability";
import { UnrecoverableError } from "bullmq";
import { safeErrorFields } from "../log-error";
import { buildClassifyInput } from "./classify-input";

export interface ClassifyThreadDeps {
  db: Db;
  encryptor: Encryptor;
  ai: AiProvider;
  logger: Logger;
}

export function classifyThreadHandler(deps: ClassifyThreadDeps) {
  return async ({ threadId }: { threadId: string }, _context?: unknown): Promise<void> => {
    const source = await getThreadForClassification(deps.db, threadId);
    if (!source) return; // thread deleted since the scan
    const latest = source.messages.at(-1);
    if (!latest || latest.isFromUser) return;
    const existing = await getThreadInsight(deps.db, threadId);
    if (existing?.classifiedThroughMessageId === latest.id) return;

    const credential = await getAiCredentialForUse(deps.db, source.userId);
    if (credential?.status !== "valid") return;
    // Just-in-time decryption; the key lives only in this function's scope.
    const apiKey = await deps.encryptor.decryptString(
      credential.keyCiphertext,
      aad.aiCredential(source.userId, "anthropic"),
    );
    const model = await getClassificationModel(deps.db, source.userId);
    const input = await buildClassifyInput(deps.encryptor, source);

    let result: Awaited<ReturnType<AiProvider["classify"]>>;
    try {
      result = await deps.ai.classify(
        {
          apiKey,
          model,
          onUsage: async (usage) => {
            // The adapter ignores failures here, so log them (never content or the key).
            try {
              await recordAiUsage(deps.db, {
                userId: source.userId,
                mailAccountId: source.thread.mailAccountId,
                task: "classify",
                aiProvider: deps.ai.id,
                model,
                ...usage,
              });
            } catch (error) {
              deps.logger.warn(
                { threadId, error: safeErrorFields(error) },
                "ai usage not recorded",
              );
            }
          },
        },
        input,
      );
    } catch (error) {
      if (error instanceof AiKeyInvalidError) {
        await markAiCredentialInvalid(deps.db, source.userId);
        throw new UnrecoverableError(error.name);
      }
      if (isRetryableAiError(error)) throw error;
      // Refusal, bad output or a rejected request: retrying the same input won't help.
      throw new UnrecoverableError(error instanceof Error ? error.name : "AiError");
    }

    const category = deriveCategory(result);
    await upsertThreadInsight(deps.db, {
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
    });
    deps.logger.info({ threadId, category }, "thread classified");
  };
}
