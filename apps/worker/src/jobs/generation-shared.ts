import {
  AiError,
  AiKeyInvalidError,
  type AiProvider,
  type AiUsage,
  isRetryableAiError,
} from "@replywise/ai";
import type { AiTask } from "@replywise/core";
import { aad, type Encryptor } from "@replywise/crypto";
import {
  type ClassificationSource,
  type Db,
  getAiCredentialForUse,
  markAiCredentialInvalid,
  recordAiUsage,
} from "@replywise/db";
import type { GmailDraftsFactory } from "@replywise/mail";
import type { MailboxDeps } from "@replywise/mailbox";
import type { Logger } from "@replywise/observability";
import { JOB_ATTEMPTS, type JobContext, type JobQueue } from "@replywise/queue";
import { UnrecoverableError } from "bullmq";
import { safeErrorFields, sanitizeError } from "../log-error";
import { errorCode } from "./generation-errors";

export interface GenerationDeps {
  db: Db;
  encryptor: Encryptor;
  ai: AiProvider;
  logger: Logger;
  queue?: JobQueue;
  gmailDrafts?: GmailDraftsFactory;
  mailbox?: MailboxDeps;
}

/** Handlers run with a context from BullMQ; direct calls (tests) default to the first attempt. */
export const FIRST_ATTEMPT: JobContext = { jobId: undefined, attempt: 1 };

export function isFinalAttempt(context: JobContext): boolean {
  return context.attempt >= JOB_ATTEMPTS;
}

/** The user's decrypted key when it is stored and valid; null otherwise. */
export async function loadUsableKey(
  deps: Pick<GenerationDeps, "db" | "encryptor">,
  userId: string,
): Promise<{ apiKey: string; version: Date } | null> {
  const credential = await getAiCredentialForUse(deps.db, userId);
  if (credential?.status !== "valid") return null;
  // Just-in-time decryption; the key lives only in the caller's scope.
  const apiKey = await deps.encryptor.decryptString(
    credential.keyCiphertext,
    aad.aiCredential(userId, "anthropic"),
  );
  return { apiKey, version: credential.updatedAt };
}

/** `onUsage` callback: the adapter ignores failures here, so log them (never content or the key). */
export function usageRecorder(
  deps: Pick<GenerationDeps, "db" | "ai" | "logger">,
  source: ClassificationSource,
  task: AiTask,
  model: string,
  threadId: string,
): (usage: AiUsage) => Promise<void> {
  return async (usage) => {
    try {
      await recordAiUsage(deps.db, {
        userId: source.userId,
        mailAccountId: source.thread.mailAccountId,
        task,
        aiProvider: deps.ai.id,
        model,
        ...usage,
      });
    } catch (error) {
      deps.logger.warn({ threadId, error: safeErrorFields(error) }, "ai usage not recorded");
    }
  };
}

/**
 * Maps an AI call failure to a fixed row error code and a BullMQ outcome. Always throws.
 * - Key rejected: the key version is invalidated, the row failed, no retry.
 * - Retryable (rate limit, outage): rethrown for BullMQ to retry; the row is only failed on the
 *   final attempt, because completeDraft/failDraft only touch pending drafts.
 * - Anything else (refusal, bad output, rejected request): the row failed, no retry.
 */
export async function handleAiFailure(
  deps: Pick<GenerationDeps, "db" | "logger">,
  error: unknown,
  options: {
    userId: string;
    keyVersion: Date;
    threadId: string;
    context: JobContext;
    fail: (code: string) => Promise<void>;
    logMessage: string;
  },
): Promise<never> {
  const { userId, keyVersion, threadId, context, fail, logMessage } = options;
  if (isRetryableAiError(error)) {
    if (isFinalAttempt(context)) await fail(errorCode(error));
    throw error;
  }
  if (error instanceof AiKeyInvalidError) {
    // Version-guarded: a key the user saved while this call ran must not be rejected.
    await markAiCredentialInvalid(deps.db, userId, keyVersion);
  }
  await fail(errorCode(error));
  deps.logger.warn({ threadId, error: safeErrorFields(error) }, logMessage);
  throw new UnrecoverableError(error instanceof Error ? error.name : "AiError");
}

/**
 * Outer guard for every AI job. BullMQ persists message and stack in Redis, so only fixed-message
 * errors pass as they are. Any other error on the final attempt still fails the row with its fixed
 * code (best effort) so it does not stay pending or save-requested forever.
 */
export async function rethrowSafely(
  error: unknown,
  context: JobContext,
  fail?: (code: string) => Promise<void>,
): Promise<never> {
  if (error instanceof UnrecoverableError || error instanceof AiError) throw error;
  if (fail && isFinalAttempt(context)) {
    try {
      await fail(errorCode(error));
    } catch {
      // The original error is what matters; it is rethrown sanitized below.
    }
  }
  throw sanitizeError(error);
}
