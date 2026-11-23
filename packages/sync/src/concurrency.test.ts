import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("preserves order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n * 5));
      active--;
      return n * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("rejects when any call rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("stops taking new items after a failure and rejects only once in-flight calls settle", async () => {
    const started: number[] = [];
    let rejectedAt = -1;
    let inFlight = 0;
    const promise = mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 2, async (n) => {
      started.push(n);
      inFlight++;
      try {
        if (n === 0) {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("boom");
        }
        await new Promise((r) => setTimeout(r, 20));
        return n;
      } finally {
        inFlight--;
      }
    });
    await expect(
      promise.catch((error) => {
        rejectedAt = started.length;
        expect(inFlight).toBe(0);
        throw error;
      }),
    ).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 100));
    expect(started.length).toBeLessThanOrEqual(3);
    expect(started.length).toBe(rejectedAt);
  });
});
