import { afterEach, describe, expect, it, vi } from "vitest";

const countThreadViews = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("@replywise/db", () => ({
  countThreadViews: (...args: unknown[]) => countThreadViews(...args),
}));
vi.mock("./auth", () => ({ getSession: async () => ({ user: { id: "user-1" } }) }));
vi.mock("./db", () => ({ getDb: () => ({}) }));

import { loadNavCounts } from "./nav-counts";

afterEach(() => vi.restoreAllMocks());

describe("loadNavCounts", () => {
  it("returns the counts on success", async () => {
    const counts = { inbox: 1, other: 2, categories: {} };
    countThreadViews.mockResolvedValueOnce(counts);
    expect(await loadNavCounts()).toBe(counts);
  });

  it("returns null and logs a fixed message when the query rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    countThreadViews.mockRejectedValueOnce(new Error("secret user-1 detail"));
    expect(await loadNavCounts()).toBeNull();
    expect(spy).toHaveBeenCalledWith("nav counts failed", "Error");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });
});
