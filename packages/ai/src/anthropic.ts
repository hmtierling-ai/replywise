import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildClassifyPrompt, CLASSIFY_SYSTEM_PROMPT } from "./classify-prompt";
import { ClassifyOutputSchema, normalizeClassifyOutput } from "./classify-schema";
import {
  AiKeyInvalidError,
  AiOutputError,
  AiRateLimitedError,
  AiRefusalError,
  AiRequestError,
  AiUnavailableError,
} from "./errors";
import type { AiProvider } from "./types";

/** Low effort still thinks on Opus 5.5; leave room so the JSON is never cut off. */
export const CLASSIFY_MAX_TOKENS = 4_096;
/** Models that accept the server-side refusal fallback (Haiku 5.5 does not). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5"]);

function mapError(error: unknown): Error {
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiKeyInvalidError();
  }
  if (error instanceof Anthropic.RateLimitError) return new AiRateLimitedError();
  if (error instanceof Anthropic.APIConnectionError) return new AiUnavailableError(0);
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    return status >= 500 || status === 0
      ? new AiUnavailableError(status)
      : new AiRequestError(status);
  }
  // Parsing/validation failures of the structured output.
  return new AiOutputError();
}

export function createAnthropicProvider(
  options: { client?: (apiKey: string) => Anthropic } = {},
): AiProvider {
  const clientFor =
    options.client ??
    ((apiKey: string) => new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 }));

  return {
    id: "anthropic",

    async validateKey(apiKey) {
      try {
        await clientFor(apiKey).models.list({ limit: 1 });
        return { ok: true };
      } catch (error) {
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError ||
          (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403))
        ) {
          return { ok: false, reason: "invalid" };
        }
        return { ok: false, reason: "unreachable" };
      }
    },

    async classify(ctx, input) {
      const client = clientFor(ctx.apiKey);
      const fallback = FALLBACK_MODELS.has(ctx.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {};
      let response: Awaited<ReturnType<typeof client.beta.messages.parse>>;
      try {
        response = await client.beta.messages.parse({
          model: ctx.model,
          max_tokens: CLASSIFY_MAX_TOKENS,
          ...fallback,
          system: [
            { type: "text", text: CLASSIFY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: buildClassifyPrompt(input) }],
          output_config: { effort: "low", format: betaZodOutputFormat(ClassifyOutputSchema) },
        });
      } catch (error) {
        throw mapError(error);
      }
      await ctx.onUsage({
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      });
      if (response.stop_reason === "refusal") throw new AiRefusalError();
      const parsed = response.parsed_output;
      if (!parsed) throw new AiOutputError();
      return normalizeClassifyOutput(parsed);
    },
  };
}
