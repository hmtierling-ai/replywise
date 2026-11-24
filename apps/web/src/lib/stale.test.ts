import { describe, expect, it } from "vitest";
import { isOlderThan } from "./stale";

describe("isOlderThan", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  it("is false for a recent timestamp and true at or past the limit", () => {
    expect(isOlderThan(new Date(now.getTime() - 299_999), now, 300_000)).toBe(false);
    expect(isOlderThan(new Date(now.getTime() - 300_000), now, 300_000)).toBe(true);
    expect(isOlderThan(new Date(now.getTime() - 900_000), now, 300_000)).toBe(true);
  });
});
