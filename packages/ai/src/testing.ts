import type { AiProvider, ClassifyInput, ClassifyResult, KeyValidation } from "./types";

export interface FakeAiProvider extends AiProvider {
  calls: Array<{ apiKey: string; model: string; input: ClassifyInput }>;
}

/** Deterministic provider for tests: returns `result` (or throws `error`) and reports fixed usage. */
export function createFakeAiProvider(
  options: { result?: ClassifyResult; error?: Error; validation?: KeyValidation } = {},
): FakeAiProvider {
  const calls: FakeAiProvider["calls"] = [];
  return {
    id: "anthropic",
    calls,
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
  };
}
