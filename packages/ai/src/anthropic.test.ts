import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { CLASSIFY_MAX_TOKENS, createAnthropicProvider } from "./anthropic";
import { CLASSIFY_SYSTEM_PROMPT } from "./classify-prompt";
import { DRAFT_SYSTEM_PROMPT } from "./draft-prompt";
import {
  AiKeyInvalidError,
  AiOutputError,
  AiRateLimitedError,
  AiRefusalError,
  AiRequestError,
  AiUnavailableError,
} from "./errors";
import { SUMMARY_SYSTEM_PROMPT } from "./summarize-prompt";
import type { ClassifyInput, DraftReplyInput } from "./types";

const input: ClassifyInput = {
  mailboxEmail: "me@gmail.com",
  subject: "Contract",
  messages: [
    {
      from: { name: "Ada", address: "ada@client.com" },
      to: [{ name: null, address: "me@gmail.com" }],
      sentAt: new Date("2026-11-20T10:00:00Z"),
      isFromUser: false,
      text: "Can you sign by Friday?",
      hasAttachments: true,
    },
  ],
};

function fakeClient(create: (params: unknown) => unknown, list?: () => unknown) {
  return {
    beta: { messages: { create: vi.fn(async (p: unknown, _o?: unknown) => create(p)) } },
    models: { list: vi.fn(async (_p?: unknown, _o?: unknown) => (list ? list() : { data: [] })) },
  } as unknown as Anthropic;
}

function paramsOf(client: Anthropic): Record<string, unknown> {
  return vi.mocked(client.beta.messages.create).mock.calls[0]?.[0] as unknown as Record<
    string,
    unknown
  >;
}

const ok = {
  stop_reason: "end_turn",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        urgency: 4,
        importance: 5,
        needs_reply: true,
        reasons: ["Client asks for a signature."],
      }),
    },
  ],
  usage: {
    input_tokens: 900,
    output_tokens: 120,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 50,
  },
};

const opusCtx = { apiKey: "k", model: "claude-opus-5-5", onUsage: () => {} };

describe("createAnthropicProvider.classify", () => {
  it("sends one structured, tool-less, low-effort request and reports usage", async () => {
    const client = fakeClient(() => ok);
    const onUsage = vi.fn();
    const provider = createAnthropicProvider({ client: () => client });
    const result = await provider.classify(
      { apiKey: "sk-ant-test", model: "claude-opus-5-5", onUsage },
      input,
    );
    expect(result).toEqual({
      urgency: 4,
      importance: 5,
      needsReply: true,
      reasons: ["Client asks for a signature."],
    });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 950,
      outputTokens: 120,
      cacheReadTokens: 300,
    });
    const params = paramsOf(client);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
    expect(params.output_config).toMatchObject({ effort: "low" });
    expect(params.output_config).toHaveProperty("format");
    expect(params.max_tokens).toBe(CLASSIFY_MAX_TOKENS);
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.system).toEqual([
      expect.objectContaining({ cache_control: { type: "ephemeral" } }),
    ]);
    expect(JSON.stringify(params.system)).toContain(CLASSIFY_SYSTEM_PROMPT.slice(0, 40));
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Can you sign by Friday?");
  });

  it("disables SDK-level retries so BullMQ alone retries (no multiplied billed attempts)", async () => {
    const client = fakeClient(() => ok);
    await createAnthropicProvider({ client: () => client }).classify(opusCtx, input);
    expect(vi.mocked(client.beta.messages.create).mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 0,
    });
  });

  it("omits the server-side fallback for Haiku and passes the model through", async () => {
    const client = fakeClient(() => ok);
    await createAnthropicProvider({ client: () => client }).classify(
      { apiKey: "k", model: "claude-haiku-5-5", onUsage: () => {} },
      input,
    );
    const params = paramsOf(client);
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("maps refusals and missing output to fixed AI errors", async () => {
    const refusal = createAnthropicProvider({
      client: () => fakeClient(() => ({ ...ok, stop_reason: "refusal", content: [] })),
    });
    await expect(refusal.classify(opusCtx, input)).rejects.toBeInstanceOf(AiRefusalError);
    const empty = createAnthropicProvider({
      client: () => fakeClient(() => ({ ...ok, content: [] })),
    });
    await expect(empty.classify(opusCtx, input)).rejects.toBeInstanceOf(AiOutputError);
  });

  it.each([
    [400, AiRequestError],
    [401, AiKeyInvalidError],
    [403, AiKeyInvalidError],
    [429, AiRateLimitedError],
    [500, AiUnavailableError],
    [529, AiUnavailableError],
  ])("maps HTTP %i to the fixed AI error", async (status, ErrorClass) => {
    const provider = createAnthropicProvider({
      client: () =>
        fakeClient(() => {
          throw Anthropic.APIError.generate(
            status,
            { type: "error" },
            "provider text",
            new Headers(),
          );
        }),
    });
    const error = await provider.classify(opusCtx, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect((error as Error).message).not.toContain("provider text");
  });

  it("maps connection and unknown errors to AiUnavailableError", async () => {
    for (const thrown of [new Anthropic.APIConnectionError({ message: "boom" }), new Error("x")]) {
      const provider = createAnthropicProvider({
        client: () =>
          fakeClient(() => {
            throw thrown;
          }),
      });
      await expect(provider.classify(opusCtx, input)).rejects.toBeInstanceOf(AiUnavailableError);
    }
  });

  it.each([
    [
      "truncated JSON",
      {
        ...ok,
        stop_reason: "max_tokens",
        content: [{ type: "text", text: '{"urgency": 4, "imp' }],
      },
    ],
    ["schema mismatch", { ...ok, content: [{ type: "text", text: '{"urgency": 99}' }] }],
  ])("records usage then throws AiOutputError on %s", async (_name, response) => {
    const onUsage = vi.fn();
    const provider = createAnthropicProvider({ client: () => fakeClient(() => response) });
    await expect(
      provider.classify({ apiKey: "k", model: "claude-opus-5-5", onUsage }, input),
    ).rejects.toBeInstanceOf(AiOutputError);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("still returns the classification when onUsage throws", async () => {
    const provider = createAnthropicProvider({ client: () => fakeClient(() => ok) });
    const result = await provider.classify(
      {
        apiKey: "k",
        model: "claude-opus-5-5",
        onUsage: () => {
          throw new Error("db down");
        },
      },
      input,
    );
    expect(result.urgency).toBe(4);
  });
});

function textResponse(payload: unknown) {
  return { ...ok, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const draftInput: DraftReplyInput = {
  ...input,
  tone: "friendly",
  instructions: "Say yes",
  writingStyleNotes: "Sign off with Cheers",
  replyLanguage: null,
};

describe("createAnthropicProvider.summarize / draftReply", () => {
  it("summarize sends a medium-effort, tool-less request with the summary prompt", async () => {
    const client = fakeClient(() => textResponse({ summary: "  Ada wants a signature.  " }));
    const onUsage = vi.fn();
    const result = await createAnthropicProvider({ client: () => client }).summarize(
      { ...opusCtx, onUsage },
      input,
    );
    expect(result).toEqual({ summary: "Ada wants a signature." });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 950,
      outputTokens: 120,
      cacheReadTokens: 300,
    });
    const params = paramsOf(client);
    expect(params.output_config).toMatchObject({ effort: "medium" });
    expect(params.max_tokens).toBe(8192);
    for (const key of ["tools", "thinking", "temperature", "top_p", "top_k"]) {
      expect(params).not.toHaveProperty(key);
    }
    expect(params.system).toEqual([
      expect.objectContaining({
        text: SUMMARY_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      }),
    ]);
    const messages = params.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toContain("Summarize the email thread above");
    expect(vi.mocked(client.beta.messages.create).mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });

  it("draftReply sends the draft prompt with thread and owner preferences", async () => {
    const client = fakeClient(() => textResponse({ body: "Hi Ada,\r\n\r\nYes.  " }));
    const result = await createAnthropicProvider({ client: () => client }).draftReply(
      opusCtx,
      draftInput,
    );
    expect(result).toEqual({ body: "Hi Ada,\n\nYes." });
    const params = paramsOf(client);
    expect(params.output_config).toMatchObject({ effort: "medium" });
    expect(params.max_tokens).toBe(8192);
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("thinking");
    expect(params.system).toEqual([
      expect.objectContaining({ text: DRAFT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }),
    ]);
    const content = (params.messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(content).toContain("<email_thread");
    expect(content).toContain("<owner_preferences");
    expect(JSON.stringify(params.system)).not.toContain("Say yes");
    expect(params.output_config).toHaveProperty("format");
    expect(content.slice(content.indexOf("<owner_preferences"))).toContain("Say yes");
    expect(vi.mocked(client.beta.messages.create).mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });

  it("sends the fallback only for Opus", async () => {
    const haiku = { apiKey: "k", model: "claude-haiku-5-5", onUsage: () => {} };
    const a = fakeClient(() => textResponse({ summary: "s" }));
    await createAnthropicProvider({ client: () => a }).summarize(haiku, input);
    expect(paramsOf(a)).not.toHaveProperty("fallbacks");
    const b = fakeClient(() => textResponse({ body: "b" }));
    await createAnthropicProvider({ client: () => b }).draftReply(haiku, draftInput);
    expect(paramsOf(b)).not.toHaveProperty("fallbacks");
    const c = fakeClient(() => textResponse({ body: "b" }));
    await createAnthropicProvider({ client: () => c }).draftReply(opusCtx, draftInput);
    expect(paramsOf(c).fallbacks).toBe("default");
    expect(paramsOf(c).betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(paramsOf(a)).not.toHaveProperty("betas");
    expect(paramsOf(b)).not.toHaveProperty("betas");
  });

  it("records usage then throws AiRefusalError on refusal", async () => {
    const onUsage = vi.fn();
    const provider = createAnthropicProvider({
      client: () => fakeClient(() => ({ ...ok, stop_reason: "refusal", content: [] })),
    });
    await expect(provider.summarize({ ...opusCtx, onUsage }, input)).rejects.toBeInstanceOf(
      AiRefusalError,
    );
    await expect(provider.draftReply({ ...opusCtx, onUsage }, draftInput)).rejects.toBeInstanceOf(
      AiRefusalError,
    );
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it("throws AiOutputError for an empty summary", async () => {
    const provider = createAnthropicProvider({
      client: () => fakeClient(() => textResponse({ summary: "  " })),
    });
    await expect(provider.summarize(opusCtx, input)).rejects.toBeInstanceOf(AiOutputError);
  });
});

describe("createAnthropicProvider.validateKey", () => {
  it("is ok when the Models API answers, invalid on 401/403, unreachable otherwise", async () => {
    const good = createAnthropicProvider({ client: () => fakeClient(() => ok) });
    expect(await good.validateKey("sk-ant-x")).toEqual({ ok: true });
    for (const status of [401, 403]) {
      const bad = createAnthropicProvider({
        client: () =>
          fakeClient(
            () => ok,
            () => {
              throw Anthropic.APIError.generate(status, { type: "error" }, "nope", new Headers());
            },
          ),
      });
      expect(await bad.validateKey("sk-ant-x")).toEqual({ ok: false, reason: "invalid" });
    }
    const down = createAnthropicProvider({
      client: () =>
        fakeClient(
          () => ok,
          () => {
            throw new Error("network");
          },
        ),
    });
    expect(await down.validateKey("sk-ant-x")).toEqual({ ok: false, reason: "unreachable" });
  });

  it("fails fast: one 10 s attempt, no SDK retries", async () => {
    const client = fakeClient(() => ok);
    await createAnthropicProvider({ client: () => client }).validateKey("sk-ant-x");
    expect(vi.mocked(client.models.list).mock.calls[0]).toEqual([
      { limit: 1 },
      { timeout: 10_000, maxRetries: 0 },
    ]);
  });
});
