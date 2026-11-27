import { describe, expect, it } from "vitest";
import { createGmailSendApi } from "./gmail-send";
import { ProviderHttpError } from "./http";
import type { FetchLike } from "./types";

function fakeFetch(status: number, body: unknown = {}) {
  const calls: Array<{ method: string | undefined; url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      method: init?.method,
      url: String(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

describe("createGmailSendApi", () => {
  it("sends an existing draft by id and returns the Gmail message id", async () => {
    const { calls, fetchImpl } = fakeFetch(200, {
      id: "msg-1",
      threadId: "t1",
      labelIds: ["SENT"],
    });
    const api = createGmailSendApi("tok", { fetch: fetchImpl });
    await expect(api.sendDraft("r-1")).resolves.toEqual({ messageId: "msg-1", threadId: "t1" });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        body: { id: "r-1" },
      },
    ]);
  });

  it("marks a 429 as rate limited and a 400 as a plain failure", async () => {
    const limited = createGmailSendApi("tok", { fetch: fakeFetch(429).fetchImpl });
    await expect(limited.sendDraft("r-1")).rejects.toMatchObject({
      status: 429,
      rateLimited: true,
    });
    const rejected = createGmailSendApi("tok", { fetch: fakeFetch(400).fetchImpl });
    await expect(rejected.sendDraft("r-1")).rejects.toMatchObject({
      status: 400,
      rateLimited: false,
    });
  });

  it("treats a success without a message id as a failure", async () => {
    const api = createGmailSendApi("tok", { fetch: fakeFetch(200, {}).fetchImpl });
    await expect(api.sendDraft("r-1")).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("reports a timeout as status 0", async () => {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    const api = createGmailSendApi("tok", { fetch: fetchImpl });
    await expect(api.sendDraft("r-1")).rejects.toMatchObject({ status: 0 });
  });
});
