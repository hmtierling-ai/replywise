import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { CLASSIFY_MAX_TOKENS, createAnthropicProvider } from "./anthropic";
import { CLASSIFY_SYSTEM_PROMPT } from "./classify-prompt";
import {
  AiKeyInvalidError,
  AiOutputError,
  AiRateLimitedError,
  AiRefusalError,
  AiRequestError,
  AiUnavailableError,
} from "./errors";
import type { ClassifyInput } from "./types";

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
    beta: { messages: { create: vi.fn(async (p: unknown) => create(p)) } },
    models: { list: vi.fn(async () => (list ? list() : { data: [] })) },
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
});
