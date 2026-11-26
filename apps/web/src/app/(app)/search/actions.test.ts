// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LimiterStore } from "@/lib/search-limit";
import { memoryStore } from "@/lib/search-limit.testing";

const BOX_ID = "44444444-4444-4444-8444-444444444444";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

const { store, syncMocks, redirect } = vi.hoisted(() => ({
  store: { current: null as LimiterStore | null },
  syncMocks: {
    GMAIL_QUERY_MAX_CHARS: 200,
    importThread: vi.fn(),
    searchGmailThreads: vi.fn(),
  },
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/redis-limiter", () => ({ getLimiterStore: () => store.current }));
vi.mock("@/lib/sync", () => ({ getGmailSearchDeps: () => ({}) }));
vi.mock("@replywise/sync", () => syncMocks);
vi.mock("next/navigation", () => ({ redirect }));

import { importGmailThreadAction, searchGmailAction } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  store.current = memoryStore();
  syncMocks.searchGmailThreads.mockResolvedValue([
    {
      providerThreadId: "g1",
      subject: "Old invoice",
      from: { name: "Billing", address: "billing@vendor.example" },
      date: new Date("2024-03-01T10:00:00Z"),
      snippet: "Your invoice",
      localThreadId: null,
    },
  ]);
});

describe("searchGmailAction", () => {
  it("returns plain hits and frees the in-flight slot", async () => {
    const result = await searchGmailAction({ mailAccountId: BOX_ID, q: " invoice " });
    expect(result).toEqual({
      ok: true,
      hits: [
        {
          providerThreadId: "g1",
          subject: "Old invoice",
          from: "Billing",
          date: "2024-03-01T10:00:00.000Z",
          snippet: "Your invoice",
          localThreadId: null,
        },
      ],
    });
    expect(syncMocks.searchGmailThreads).toHaveBeenCalledWith(
      {},
      { userId: "user-1", mailAccountId: BOX_ID, query: "invoice" },
    );
    expect((await searchGmailAction({ mailAccountId: BOX_ID, q: "x" })).ok).toBe(true);
  });

  it("rejects empty, long or malformed input without calling Gmail", async () => {
    for (const input of [
      { mailAccountId: BOX_ID, q: "  " },
      { mailAccountId: BOX_ID, q: "a".repeat(201) },
      { mailAccountId: "nope", q: "invoice" },
    ]) {
      expect(await searchGmailAction(input)).toEqual({ ok: false, error: "invalid_query" });
    }
    expect(syncMocks.searchGmailThreads).not.toHaveBeenCalled();
  });

  it("returns a fixed code, never the provider's text", async () => {
    syncMocks.searchGmailThreads.mockRejectedValue(
      Object.assign(new Error("secret invoice text"), { name: "ReauthRequiredError" }),
    );
    const result = await searchGmailAction({ mailAccountId: BOX_ID, q: "invoice" });
    expect(result).toEqual({ ok: false, error: "needs_reauth" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("refuses the 31st search in a minute", async () => {
    // Pin the clock so the loop cannot straddle a minute boundary.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T12:00:10Z"));
    for (let i = 0; i < 30; i++) {
      expect((await searchGmailAction({ mailAccountId: BOX_ID, q: "x" })).ok).toBe(true);
    }
    expect(await searchGmailAction({ mailAccountId: BOX_ID, q: "x" })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    vi.useRealTimers();
  });
});

describe("importGmailThreadAction", () => {
  it("imports and redirects to the local thread", async () => {
    syncMocks.importThread.mockResolvedValue(THREAD_ID);
    await expect(
      importGmailThreadAction({ mailAccountId: BOX_ID, providerThreadId: "g1" }),
    ).rejects.toThrow(`NEXT_REDIRECT /thread/${THREAD_ID}`);
    expect(syncMocks.importThread).toHaveBeenCalledWith(
      {},
      { userId: "user-1", mailAccountId: BOX_ID, providerThreadId: "g1" },
    );
  });

  it("reports gmail_error when Gmail no longer has the thread, and validates ids", async () => {
    syncMocks.importThread.mockResolvedValue(null);
    expect(
      await importGmailThreadAction({ mailAccountId: BOX_ID, providerThreadId: "g1" }),
    ).toEqual({ ok: false, error: "gmail_error" });
    expect(
      await importGmailThreadAction({ mailAccountId: BOX_ID, providerThreadId: "../x" }),
    ).toEqual({ ok: false, error: "invalid_query" });
  });
});
