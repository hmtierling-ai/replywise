import {
  AiError,
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
import { safeErrorFields, sanitizeError } from "../log-error";
import { buildClassifyInput } from "./classify-input";

export interface ClassifyThreadDeps {
  db: Db;
  encryptor: Encryptor;
  ai: AiProvider;
  logger: Logger;
}

const INSIGHT_WRITE_TRIES = 3;
const INSIGHT_WRITE_BASE_DELAY_MS = 200;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function classifyThreadHandler(deps: ClassifyThreadDeps) {
  return async (
    payload: { threadId: string; messageId: string },
    _context?: unknown,
  ): Promise<void> => {
    try {
      await classify(deps, payload);
    } catch (error) {
      // BullMQ persists message and stack in Redis: only fixed-message errors may pass as they are.
      if (error instanceof UnrecoverableError || error instanceof AiError) throw error;
      throw sanitizeError(error);
    }
  };
}

async function classify(
  deps: ClassifyThreadDeps,
  { threadId, messageId }: { threadId: string; messageId: string },
): Promise<void> {
  const source = await getThreadForClassification(deps.db, threadId);
  if (!source) return; // thread deleted since the scan
  const latest = source.messages.at(-1);
  if (!latest || latest.isFromUser) return;
  // A newer message has its own job; do not pay for a stale one.
  if (latest.id !== messageId) return;
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
            deps.logger.warn({ threadId, error: safeErrorFields(error) }, "ai usage not recorded");
          }
        },
      },
      input,
    );
  } catch (error) {
    if (error instanceof AiKeyInvalidError) {
      // Version-guarded: a key the user saved while this call ran must not be rejected.
      await markAiCredentialInvalid(deps.db, source.userId, credential.updatedAt);
      deps.logger.warn({ threadId, error: safeErrorFields(error) }, "classification failed");
      throw new UnrecoverableError(error.name);
    }
    if (isRetryableAiError(error)) throw error;
    // Refusal, bad output or a rejected request: retrying the same input won't help.
    deps.logger.warn({ threadId, error: safeErrorFields(error) }, "classification failed");
    throw new UnrecoverableError(error instanceof Error ? error.name : "AiError");
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
  for (let attempt = 1; ; attempt++) {
    try {
      await upsertThreadInsight(deps.db, insight);
      break;
    } catch (error) {
      if (attempt >= INSIGHT_WRITE_TRIES) {
        deps.logger.warn({ threadId, error: safeErrorFields(error) }, "insight write failed");
        throw new UnrecoverableError("InsightWriteFailed");
      }
      await sleep(INSIGHT_WRITE_BASE_DELAY_MS * attempt);
    }
  }
  deps.logger.info({ threadId, category }, "thread classified");
}
