import type {
  AiProvider,
  ClassifyInput,
  ClassifyResult,
  DraftReplyInput,
  KeyValidation,
} from "./types";

export interface FakeAiProvider extends AiProvider {
  calls: Array<{ apiKey: string; model: string; input: ClassifyInput }>;
  summarizeCalls: Array<{ apiKey: string; model: string; input: ClassifyInput }>;
  draftCalls: Array<{ apiKey: string; model: string; input: DraftReplyInput }>;
}

/** Deterministic provider for tests: returns canned output (or throws `error`) and reports fixed usage. */
export function createFakeAiProvider(
  options: {
    result?: ClassifyResult;
    summary?: string;
    draft?: string;
    error?: Error;
    validation?: KeyValidation;
  } = {},
): FakeAiProvider {
  const calls: FakeAiProvider["calls"] = [];
  const summarizeCalls: FakeAiProvider["summarizeCalls"] = [];
  const draftCalls: FakeAiProvider["draftCalls"] = [];
  return {
    id: "anthropic",
    calls,
    summarizeCalls,
    draftCalls,
    async validateKey() {
      return options.validation ?? { ok: true };
    },
    async classify(ctx, input) {
      calls.push({ apiKey: ctx.apiKey, model: ctx.model, input });
      await ctx.onUsage({ inputTokens: 1200, outputTokens: 150, cacheReadTokens: 0 });
      if (options.error) throw options.error;
      return (
        options.result ?? {
          urgency: 2,
          importance: 3,
          needsReply: true,
          reasons: ["A colleague asks a question."],
        }
      );
    },
    async summarize(ctx, input) {
      summarizeCalls.push({ apiKey: ctx.apiKey, model: ctx.model, input });
      await ctx.onUsage({ inputTokens: 1200, outputTokens: 150, cacheReadTokens: 0 });
      if (options.error) throw options.error;
      return { summary: options.summary ?? "Ada asks you to sign the contract by Friday." };
    },
    async draftReply(ctx, input) {
      draftCalls.push({ apiKey: ctx.apiKey, model: ctx.model, input });
      await ctx.onUsage({ inputTokens: 1200, outputTokens: 150, cacheReadTokens: 0 });
      if (options.error) throw options.error;
      return { body: options.draft ?? "Hi Ada,\n\nYes — I'll sign it by Friday." };
    },
  };
}
