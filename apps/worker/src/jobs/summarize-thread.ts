import {
  completeSummary,
  failSummary,
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
  usageRecorder,
} from "./generation-shared";
import { buildThreadInput } from "./thread-text";

export type SummarizeThreadDeps = Pick<GenerationDeps, "db" | "encryptor" | "ai" | "logger">;

export function summarizeThreadHandler(deps: SummarizeThreadDeps) {
  return async (
    { threadId }: { threadId: string },
    context: JobContext = FIRST_ATTEMPT,
  ): Promise<void> => {
    try {
      await summarize(deps, threadId, context);
    } catch (error) {
      await rethrowSafely(error, context, (code) => failSummary(deps.db, threadId, code));
    }
  };
}

async function summarize(
  deps: SummarizeThreadDeps,
  threadId: string,
  context: JobContext,
): Promise<void> {
  const source = await getThreadForClassification(deps.db, threadId);
  if (!source) return; // thread deleted since the request
  const latest = source.messages.at(-1);
  if (!latest) return failSummary(deps.db, threadId, "internal");
  const key = await loadUsableKey(deps, source.userId);
  if (!key) return failSummary(deps.db, threadId, "no_ai_key");
  const { generationModel: model } = await getWritingPreferences(deps.db, source.userId);
  const input = await buildThreadInput(deps.encryptor, source);

  let summary: string;
  try {
    ({ summary } = await deps.ai.summarize(
      {
        apiKey: key.apiKey,
        model,
        onUsage: usageRecorder(deps, source, "summarize", model, threadId),
      },
      input,
    ));
  } catch (error) {
    return handleAiFailure(deps, error, {
      userId: source.userId,
      keyVersion: key.version,
      threadId,
      context,
      fail: (code) => failSummary(deps.db, threadId, code),
      logMessage: "summary failed",
    });
  }
  await completeSummary(deps.db, { threadId, summary, throughMessageId: latest.id, model });
  deps.logger.info({ threadId }, "thread summarized");
}
