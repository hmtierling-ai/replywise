import { describe, expect, it } from "vitest";
import { formatParticipants, formatSyncStatus, formatThreadTime } from "./inbox-format";

describe("formatParticipants", () => {
  it("names other people first, falls back to addresses, and summarises extras", () => {
    expect(
      formatParticipants(
        [
          { name: null, address: "me@gmail.com" },
          { name: "Ada Lovelace", address: "ada@x.com" },
          { name: null, address: "bob@y.com" },
          { name: "Carol", address: "carol@z.com" },
        ],
        ["me@gmail.com"],
      ),
    ).toBe("Ada Lovelace, bob@y.com +1");
  });

  it("shows 'me' when the only participant is the owner", () => {
    expect(formatParticipants([{ name: "Me", address: "me@gmail.com" }], ["me@gmail.com"])).toBe(
      "me",
    );
    expect(formatParticipants([], [])).toBe("(no sender)");
  });
});

describe("formatThreadTime", () => {
  const now = new Date("2026-11-17T15:00:00Z");
  it("uses the time for today, month/day this year, and the full date otherwise", () => {
    expect(formatThreadTime(new Date("2026-11-17T09:05:00Z"), now, "UTC")).toBe("09:05");
    expect(formatThreadTime(new Date("2026-03-04T09:05:00Z"), now, "UTC")).toBe("Mar 4");
    expect(formatThreadTime(new Date("2025-12-31T09:05:00Z"), now, "UTC")).toBe("Dec 31, 2025");
  });
});

describe("formatSyncStatus", () => {
  const now = new Date("2026-11-17T15:00:00Z");
  it("describes never-synced, recent, older and failing mailboxes", () => {
    expect(formatSyncStatus({ status: "active", lastSyncedAt: null, lastError: null }, now)).toBe(
      "Syncing your inbox…",
    );
    expect(
      formatSyncStatus(
        { status: "active", lastSyncedAt: new Date("2026-11-17T14:59:30Z"), lastError: null },
        now,
      ),
    ).toBe("Synced just now");
    expect(
      formatSyncStatus(
        { status: "active", lastSyncedAt: new Date("2026-11-17T14:40:00Z"), lastError: null },
        now,
      ),
    ).toBe("Synced 20 min ago");
    expect(
      formatSyncStatus(
        {
          status: "active",
          lastSyncedAt: new Date("2026-11-17T12:00:00Z"),
          lastError: "Gmail API request failed (500)",
        },
        now,
      ),
    ).toBe("Last sync failed: Gmail API request failed (500)");
    expect(
      formatSyncStatus({ status: "needs_reauth", lastSyncedAt: null, lastError: "x" }, now),
    ).toBe("Paused until you reconnect");
  });
});
