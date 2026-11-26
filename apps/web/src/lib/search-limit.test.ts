import { describe, expect, it } from "vitest";
import {
  acquireGmailSearchSlot,
  countGmailRequest,
  GMAIL_SEARCHES_PER_MINUTE,
} from "./search-limit";
import { memoryStore } from "./search-limit.testing";

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

describe("acquireGmailSearchSlot", () => {
  it("allows one search at a time per user", async () => {
    const store = memoryStore();
    const first = await acquireGmailSearchSlot(store, "u1", NOW);
    expect(first.ok).toBe(true);
    expect((await acquireGmailSearchSlot(store, "u1", NOW)).ok).toBe(false);
    expect((await acquireGmailSearchSlot(store, "u2", NOW)).ok).toBe(true);
    if (first.ok) await first.release();
    expect((await acquireGmailSearchSlot(store, "u1", NOW)).ok).toBe(true);
  });

  it("allows 30 Gmail requests per minute, then refuses until the next minute", async () => {
    const store = memoryStore();
    for (let i = 0; i < GMAIL_SEARCHES_PER_MINUTE; i++) {
      expect(await countGmailRequest(store, "u1", NOW)).toBe(true);
    }
    const refused = await acquireGmailSearchSlot(store, "u1", NOW);
    expect(refused.ok).toBe(false);
    // The refused attempt released its lock.
    expect([...store.keys.keys()].some((k) => k.includes(":lock:"))).toBe(false);
    expect((await acquireGmailSearchSlot(store, "u1", NOW + 60_000)).ok).toBe(true);
  });
});
