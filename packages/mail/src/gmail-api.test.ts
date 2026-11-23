import { describe, expect, it } from "vitest";
import { createGmailApi, GMAIL_COST, HistoryExpiredError } from "./gmail-api";
import { ProviderHttpError } from "./http";
import type { FetchLike } from "./types";

function fakeFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url: new URL(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers,
    });
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("createGmailApi", () => {
  it("reads the profile history id with a bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { emailAddress: "Me@Gmail.com", historyId: "12345", messagesTotal: 9 } },
    ]);
    const api = createGmailApi("ya29.token", { fetch: fetchImpl, sleep: noSleep });
    expect(await api.getProfile()).toEqual({ emailAddress: "me@gmail.com", historyId: "12345" });
    expect(calls[0]?.url.toString()).toBe(`${BASE}/profile`);
    expect(calls[0]?.headers.authorization).toBe("Bearer ya29.token");
  });

  it("lists thread ids with query, page size and page token", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { threads: [{ id: "t1" }, { id: "t2" }], nextPageToken: "p2" } },
      { body: { resultSizeEstimate: 0 } },
    ]);
    const api = createGmailApi("tok", { fetch: fetchImpl, sleep: noSleep });
    expect(await api.listThreadIds({ query: "in:inbox newer_than:30d", maxResults: 100 })).toEqual({
      ids: ["t1", "t2"],
      nextPageToken: "p2",
    });
    expect(await api.listThreadIds({ query: "q", maxResults: 50, pageToken: "p2" })).toEqual({
      ids: [],
      nextPageToken: null,
    });
    expect(calls[0]?.url.pathname).toBe("/gmail/v1/users/me/threads");
    expect(calls[0]?.url.searchParams.get("q")).toBe("in:inbox newer_than:30d");
    expect(calls[0]?.url.searchParams.get("maxResults")).toBe("100");
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("gets a full thread, parses messages oldest first, and returns null when it is gone", async () => {
    const message = (id: string, internalDate: string) => ({
      id,
      threadId: "t1",
      internalDate,
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "From", value: "a@x.com" }],
        body: { data: b64(id) },
      },
    });
    const { fetchImpl, calls } = fakeFetch([
      { body: { id: "t1", messages: [message("m2", "2000"), message("m1", "1000")] } },
      { status: 404, body: { error: { code: 404 } } },
    ]);
    const api = createGmailApi("tok", { fetch: fetchImpl, sleep: noSleep });
    const thread = await api.getThread("t1");
    expect(thread?.providerThreadId).toBe("t1");
    expect(thread?.messages.map((m) => m.providerMessageId)).toEqual(["m1", "m2"]);
    expect(calls[0]?.url.pathname).toBe("/gmail/v1/users/me/threads/t1");
    expect(calls[0]?.url.searchParams.get("format")).toBe("full");
    expect(await api.getThread("gone")).toBeNull();
  });

  it("collects changed threads and deleted messages from history", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          historyId: "200",
          nextPageToken: "h2",
          history: [
            { id: "150", messagesAdded: [{ message: { id: "m9", threadId: "t9" } }] },
            {
              id: "160",
              labelsAdded: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["UNREAD"] }],
              labelsRemoved: [{ message: { id: "m9", threadId: "t9" }, labelIds: ["INBOX"] }],
              messagesDeleted: [{ message: { id: "m3", threadId: "t3" } }],
            },
          ],
        },
      },
    ]);
    const api = createGmailApi("tok", { fetch: fetchImpl, sleep: noSleep });
    expect(await api.listHistory({ startHistoryId: "100" })).toEqual({
      changedThreadIds: ["t9", "t1", "t3"],
      deletedMessageIds: ["m3"],
      historyId: "200",
      nextPageToken: "h2",
    });
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/gmail/v1/users/me/history");
    expect(url?.searchParams.get("startHistoryId")).toBe("100");
    expect(url?.searchParams.getAll("historyTypes")).toEqual([
      "messageAdded",
      "messageDeleted",
      "labelAdded",
      "labelRemoved",
    ]);
  });

  it("reports an expired history id distinctly", async () => {
    const { fetchImpl } = fakeFetch([{ status: 404, body: { error: { code: 404 } } }]);
    const api = createGmailApi("tok", { fetch: fetchImpl, sleep: noSleep });
    await expect(api.listHistory({ startHistoryId: "1" })).rejects.toBeInstanceOf(
      HistoryExpiredError,
    );
  });

  describe("pacing and rate-limit retry", () => {
    const threadOk = { body: { id: "t1", messages: [] } };
    const rateLimited = {
      status: 403,
      body: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
    };

    it("paces requests by quota cost", async () => {
      const clock = fakeClock();
      const { fetchImpl } = fakeFetch([threadOk, threadOk, threadOk]);
      const api = createGmailApi("tok", { fetch: fetchImpl, unitsPerSecond: 10, ...clock });
      await api.getThread("a");
      await api.getThread("b");
      await api.getThread("c");
      expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(
        2 * (GMAIL_COST.getThread / 10) * 1000,
        -1,
      );
    });

    it("retries a rate-limited 403 with a 5/10/20/40 s backoff", async () => {
      const clock = fakeClock();
      const { fetchImpl } = fakeFetch([
        rateLimited,
        rateLimited,
        rateLimited,
        rateLimited,
        threadOk,
      ]);
      const api = createGmailApi("tok", {
        fetch: fetchImpl,
        unitsPerSecond: 1000,
        random: () => 0.5,
        ...clock,
      });
      expect((await api.getThread("t1"))?.providerThreadId).toBe("t1");
      expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([5000, 10000, 20000, 40000]);
    });

    it("applies up to +/-20% jitter to the backoff", async () => {
      for (const [random, expected] of [
        [0, 4000],
        [1, 6000],
      ] as const) {
        const clock = fakeClock();
        const { fetchImpl } = fakeFetch([rateLimited, threadOk]);
        const api = createGmailApi("tok", {
          fetch: fetchImpl,
          unitsPerSecond: 1000,
          random: () => random,
          ...clock,
        });
        await api.getThread("t1");
        expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([expected]);
      }
    });

    it("pauses every lane during a rate-limit backoff", async () => {
      let t = 0;
      let startedSecond = false;
      let second: Promise<unknown> | undefined;
      const fetchTimes: Record<string, number> = {};
      const fetchImpl: FetchLike = async (url) => {
        const id = new URL(url).pathname.split("/").at(-1) ?? "";
        if (id === "a" && fetchTimes.a === undefined) {
          fetchTimes.a = t;
          return new Response(JSON.stringify(rateLimited.body), { status: 429 });
        }
        fetchTimes[id] ??= t;
        return new Response(JSON.stringify({ id, messages: [] }));
      };
      const api = createGmailApi("tok", {
        fetch: fetchImpl,
        unitsPerSecond: 1000,
        random: () => 0.5,
        now: () => t,
        sleep: async (ms) => {
          // A concurrent call starts while call "a" is backing off.
          const wake = t + ms;
          if (ms >= 1000 && !startedSecond) {
            startedSecond = true;
            second = api.getThread("b");
          }
          await Promise.resolve();
          t = Math.max(t, wake);
        },
      });
      await api.getThread("a");
      await second;
      expect(fetchTimes.b).toBeGreaterThanOrEqual(5000);
    });

    it("honours Retry-After on a 429", async () => {
      const clock = fakeClock();
      const { fetchImpl } = fakeFetch([
        { status: 429, body: {}, headers: { "retry-after": "3" } },
        threadOk,
      ]);
      const api = createGmailApi("tok", { fetch: fetchImpl, unitsPerSecond: 1000, ...clock });
      await api.getThread("t1");
      expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([3000]);
    });

    it("does not retry other 403s", async () => {
      const clock = fakeClock();
      const { fetchImpl, calls } = fakeFetch([
        { status: 403, body: { error: { errors: [{ reason: "insufficientPermissions" }] } } },
      ]);
      const api = createGmailApi("tok", { fetch: fetchImpl, ...clock });
      const error = await api.getThread("t1").catch((e) => e);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error.rateLimited).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it("gives up after maxRetries and rethrows the rate-limit error", async () => {
      const clock = fakeClock();
      const { fetchImpl, calls } = fakeFetch(Array.from({ length: 3 }, () => rateLimited));
      const api = createGmailApi("tok", { fetch: fetchImpl, maxRetries: 2, ...clock });
      const error = await api.getThread("t1").catch((e) => e);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error.rateLimited).toBe(true);
      expect(calls).toHaveLength(3);
    });
  });
});
