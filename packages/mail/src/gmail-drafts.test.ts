import { describe, expect, it } from "vitest";
import { createGmailDraftsApi } from "./gmail-drafts";
import { ProviderHttpError } from "./http";
import type { FetchLike } from "./types";

interface Call {
  method: string | undefined;
  url: string;
  body: unknown;
}

function fakeFetch(status: number, responseBody: unknown = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      method: init?.method,
      url: String(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(responseBody), { status });
  };
  return { calls, fetchImpl };
}

const input = { raw: "cmF3", threadId: "t1" };

describe("createGmailDraftsApi", () => {
  it("creates a draft with POST", async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: "d1" });
    const api = createGmailDraftsApi("tok", { fetch: fetchImpl });
    await expect(api.createDraft(input)).resolves.toEqual({ draftId: "d1" });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
        body: { message: { raw: "cmF3", threadId: "t1" } },
      },
    ]);
  });

  it("updates a draft with PUT", async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: "d1" });
    const api = createGmailDraftsApi("tok", { fetch: fetchImpl });
    await expect(api.updateDraft("d1", input)).resolves.toEqual({ draftId: "d1" });
    expect(calls).toEqual([
      {
        method: "PUT",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1",
        body: { id: "d1", message: { raw: "cmF3", threadId: "t1" } },
      },
    ]);
  });

  it("returns null when the draft was deleted (404)", async () => {
    const { fetchImpl } = fakeFetch(404, {});
    const api = createGmailDraftsApi("tok", { fetch: fetchImpl });
    await expect(api.updateDraft("gone", input)).resolves.toBeNull();
  });

  it("throws ProviderHttpError on 500 and 401", async () => {
    for (const status of [500, 401]) {
      const { fetchImpl } = fakeFetch(status, {});
      const api = createGmailDraftsApi("tok", { fetch: fetchImpl });
      await expect(api.updateDraft("d1", input)).rejects.toBeInstanceOf(ProviderHttpError);
      await expect(api.createDraft(input)).rejects.toMatchObject({ status });
    }
  });

  it("classifies rate limits like reads do", async () => {
    const { fetchImpl } = fakeFetch(429, {});
    const api = createGmailDraftsApi("tok", { fetch: fetchImpl });
    await expect(api.createDraft(input)).rejects.toMatchObject({ rateLimited: true });
  });

  it("rejects a response without a draft id", async () => {
    const { fetchImpl } = fakeFetch(200, {});
    const api = createGmailDraftsApi("tok", { fetch: fetchImpl });
    await expect(api.createDraft(input)).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("never requests a send endpoint", async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: "d1" });
    const api = createGmailDraftsApi("tok", { fetch: fetchImpl });
    await api.createDraft(input);
    await api.updateDraft("d1", input);
    for (const call of calls) expect(call.url).not.toMatch(/\/send/i);
  });
});
