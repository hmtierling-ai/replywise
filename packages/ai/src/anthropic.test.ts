import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic";
import { CLASSIFY_SYSTEM_PROMPT } from "./classify-prompt";
import { AiKeyInvalidError, AiOutputError, AiRateLimitedError, AiRefusalError } from "./errors";
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

function fakeClient(parse: (params: unknown) => unknown, list?: () => unknown) {
  return {
    beta: { messages: { parse: vi.fn(async (p: unknown) => parse(p)) } },
    models: { list: vi.fn(async () => (list ? list() : { data: [] })) },
  } as unknown as Anthropic;
}

const ok = {
  stop_reason: "end_turn",
  parsed_output: {
    urgency: 4,
    importance: 5,
    needs_reply: true,
    reasons: ["Client asks for a signature."],
  },
  usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 300 },
};

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
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: 300,
    });
    const params = vi.mocked(client.beta.messages.parse).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
    expect(params.output_config).toMatchObject({ effort: "low" });
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(JSON.stringify(params.system)).toContain(CLASSIFY_SYSTEM_PROMPT.slice(0, 40));
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Can you sign by Friday?");
  });

  it("omits the server-side fallback for Haiku", async () => {
    const client = fakeClient(() => ok);
    await createAnthropicProvider({ client: () => client }).classify(
      { apiKey: "k", model: "claude-haiku-5-5", onUsage: () => {} },
      input,
    );
    const params = vi.mocked(client.beta.messages.parse).mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("maps refusals, missing output and provider errors to fixed AI errors", async () => {
    const ctx = { apiKey: "k", model: "claude-opus-5-5", onUsage: () => {} };
    const refusal = createAnthropicProvider({
      client: () => fakeClient(() => ({ ...ok, stop_reason: "refusal", parsed_output: null })),
    });
    await expect(refusal.classify(ctx, input)).rejects.toBeInstanceOf(AiRefusalError);
    const empty = createAnthropicProvider({
      client: () => fakeClient(() => ({ ...ok, parsed_output: null })),
    });
    await expect(empty.classify(ctx, input)).rejects.toBeInstanceOf(AiOutputError);
    const unauthorized = createAnthropicProvider({
      client: () =>
        fakeClient(() => {
          throw Anthropic.APIError.generate(401, { type: "error" }, "unauthorized", new Headers());
        }),
    });
    await expect(unauthorized.classify(ctx, input)).rejects.toBeInstanceOf(AiKeyInvalidError);
    const limited = createAnthropicProvider({
      client: () =>
        fakeClient(() => {
          throw Anthropic.APIError.generate(429, { type: "error" }, "slow down", new Headers());
        }),
    });
    await expect(limited.classify(ctx, input)).rejects.toBeInstanceOf(AiRateLimitedError);
  });
});

describe("createAnthropicProvider.validateKey", () => {
  it("is ok when the Models API answers, invalid on 401/403, unreachable otherwise", async () => {
    const good = createAnthropicProvider({ client: () => fakeClient(() => ok) });
    expect(await good.validateKey("sk-ant-x")).toEqual({ ok: true });
    const bad = createAnthropicProvider({
      client: () =>
        fakeClient(
          () => ok,
          () => {
            throw Anthropic.APIError.generate(401, { type: "error" }, "nope", new Headers());
          },
        ),
    });
    expect(await bad.validateKey("sk-ant-x")).toEqual({ ok: false, reason: "invalid" });
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
