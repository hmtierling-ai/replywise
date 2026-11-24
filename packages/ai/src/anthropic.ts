import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { buildClassifyPrompt, CLASSIFY_SYSTEM_PROMPT } from "./classify-prompt";
import { ClassifyOutputSchema, normalizeClassifyOutput } from "./classify-schema";
import { buildDraftPrompt, DRAFT_SYSTEM_PROMPT } from "./draft-prompt";
import {
  AiKeyInvalidError,
  AiOutputError,
  AiRateLimitedError,
  AiRefusalError,
  AiRequestError,
  AiUnavailableError,
} from "./errors";
import {
  DraftOutputSchema,
  normalizeDraft,
  normalizeSummary,
  SummaryOutputSchema,
} from "./generation-schema";
import { buildSummarizePrompt, SUMMARY_SYSTEM_PROMPT } from "./summarize-prompt";
import type { AiContext, AiProvider } from "./types";

/**
 * Low effort still thinks on Opus 5.5, and thinking tokens count against this limit,
 * so leave room so the JSON is never cut off.
 */
export const CLASSIFY_MAX_TOKENS = 4_096;
/** Models that accept the server-side refusal fallback (Haiku 5.5 does not). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5"]);
/**
 * BullMQ already retries retryable AI errors with backoff; SDK retries on top would multiply
 * possibly billed attempts (e.g. a timeout after the model ran).
 */
const REQUEST_OPTIONS = { maxRetries: 0 };
export const SUMMARY_MAX_TOKENS = 4_096;
export const DRAFT_MAX_TOKENS = 8_192;
const VALIDATE_REQUEST_OPTIONS = { timeout: 10_000, maxRetries: 0 };

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
  // Any other (non-SDK) failure, e.g. a network fault.
  return new AiUnavailableError(0);
}

export function createAnthropicProvider(
  options: { client?: (apiKey: string) => Anthropic } = {},
): AiProvider {
  const clientFor =
    options.client ??
    ((apiKey: string) => new Anthropic({ apiKey, maxRetries: 0, timeout: 60_000 }));

  return {
    id: "anthropic",

    async validateKey(apiKey) {
      try {
        // Saving a key waits on this call: fail fast instead of SDK retries with long timeouts.
        await clientFor(apiKey).models.list({ limit: 1 }, VALIDATE_REQUEST_OPTIONS);
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
      const output = await structuredCall(clientFor(ctx.apiKey), ctx, {
        system: CLASSIFY_SYSTEM_PROMPT,
        user: buildClassifyPrompt(input),
        effort: "low",
        maxTokens: CLASSIFY_MAX_TOKENS,
        format: betaZodOutputFormat(ClassifyOutputSchema),
        schema: ClassifyOutputSchema,
      });
      return normalizeClassifyOutput(output);
    },

    async summarize(ctx, input) {
      const output = await structuredCall(clientFor(ctx.apiKey), ctx, {
        system: SUMMARY_SYSTEM_PROMPT,
        user: buildSummarizePrompt(input),
        effort: "medium",
        maxTokens: SUMMARY_MAX_TOKENS,
        format: betaZodOutputFormat(SummaryOutputSchema),
        schema: SummaryOutputSchema,
      });
      return normalizeSummary(output);
    },

    async draftReply(ctx, input) {
      const output = await structuredCall(clientFor(ctx.apiKey), ctx, {
        system: DRAFT_SYSTEM_PROMPT,
        user: buildDraftPrompt(input),
        effort: "medium",
        maxTokens: DRAFT_MAX_TOKENS,
        format: betaZodOutputFormat(DraftOutputSchema),
        schema: DraftOutputSchema,
      });
      return normalizeDraft(output);
    },
  };
}

/** One structured, tool-less request. Shared so every task keeps the same retry/usage/error rules. */
async function structuredCall<T>(
  client: Anthropic,
  ctx: AiContext,
  opts: {
    system: string;
    user: string;
    effort: "low" | "medium";
    maxTokens: number;
    format: ReturnType<typeof betaZodOutputFormat>;
    schema: z.ZodType<T>;
  },
): Promise<T> {
  const fallback = FALLBACK_MODELS.has(ctx.model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
  let response: Awaited<ReturnType<typeof client.beta.messages.create>>;
  try {
    // `create` (not `parse`) so usage is still recorded when the output fails to parse.
    response = await client.beta.messages.create(
      {
        model: ctx.model,
        max_tokens: opts.maxTokens,
        ...fallback,
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: opts.user }],
        output_config: { effort: opts.effort, format: opts.format },
      },
      REQUEST_OPTIONS,
    );
  } catch (error) {
    throw mapError(error);
  }
  try {
    await ctx.onUsage({
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    });
  } catch {
    // usage accounting must not change the task outcome
  }
  if (response.stop_reason === "refusal") throw new AiRefusalError();
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let parsed: ReturnType<typeof opts.schema.safeParse>;
  try {
    parsed = opts.schema.safeParse(JSON.parse(text));
  } catch {
    throw new AiOutputError();
  }
  if (!parsed.success || response.stop_reason === "max_tokens") throw new AiOutputError();
  return parsed.data;
}
