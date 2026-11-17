import { describe, expect, it } from "vitest";
import { getJson, OAuthError, ProviderHttpError, postForm } from "./http";
import type { FetchLike } from "./types";

const timeoutFetch: FetchLike = async () => {
  throw new DOMException("The operation timed out", "TimeoutError");
};

describe("provider HTTP timeout", () => {
  it("passes an AbortSignal to postForm and getJson", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      signals.push(init?.signal);
      return new Response("{}", { status: 200 });
    };
    await postForm(fetchImpl, "https://example.com/token", {});
    await getJson(fetchImpl, "https://example.com/me", "t");
    expect(signals).toHaveLength(2);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("maps a timeout to ProviderHttpError(0, pathname)", async () => {
    const post = await postForm(timeoutFetch, "https://example.com/token?x=1", {}).catch((e) => e);
    expect(post).toBeInstanceOf(ProviderHttpError);
    expect(post).toMatchObject({ status: 0, endpoint: "/token" });
    const get = await getJson(timeoutFetch, "https://example.com/v1/me", "t").catch((e) => e);
    expect(get).toMatchObject({ status: 0, endpoint: "/v1/me" });
  });

  it("maps AbortError too and lets other errors propagate", async () => {
    const aborted: FetchLike = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    await expect(getJson(aborted, "https://example.com/a", "t")).rejects.toBeInstanceOf(
      ProviderHttpError,
    );
    const boom: FetchLike = async () => {
      throw new Error("boom");
    };
    await expect(getJson(boom, "https://example.com/a", "t")).rejects.toThrow("boom");
  });
});

describe("OAuthError message", () => {
  it("does not carry provider-supplied description", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "user@example.com something" }),
        { status: 400 },
      );
    const error = await postForm(fetchImpl, "https://example.com/token", {}).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.message).toBe("invalid_grant");
    expect(error.message).not.toContain("user@example.com");
    expect(error.description).toBe("user@example.com something");
  });
});
