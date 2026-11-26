import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@replywise/queue", () => ({ createProducerConnection: () => ({}) }));
vi.mock("./env", () => ({ getEnv: () => ({ REDIS_URL: "redis://x" }) }));

import { getLimiterStore, READY_TIMEOUT_MS, ready } from "./redis-limiter";

class FakeRedis extends EventEmitter {
  status = "connecting";
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ready", () => {
  it("returns at once when already ready", async () => {
    const redis = new FakeRedis();
    redis.status = "ready";
    await expect(ready(redis)).resolves.toBeUndefined();
  });

  it("resolves when the connection becomes ready and removes its listeners", async () => {
    const redis = new FakeRedis();
    const pending = ready(redis);
    redis.emit("ready");
    await expect(pending).resolves.toBeUndefined();
    expect(redis.listenerCount("ready")).toBe(0);
    expect(redis.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once when the connection has ended", async () => {
    const redis = new FakeRedis();
    redis.status = "end";
    await expect(ready(redis)).rejects.toThrow("closed");
  });

  it("rejects when nothing happens within the timeout and cleans up", async () => {
    const redis = new FakeRedis();
    const pending = ready(redis);
    const assertion = expect(pending).rejects.toThrow("not ready in time");
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await assertion;
    expect(redis.listenerCount("ready")).toBe(0);
    expect(redis.listenerCount("error")).toBe(0);
  });
});

describe("getLimiterStore increment", () => {
  function storeWith(results: Array<[Error | null, unknown]> | null) {
    const multi = { incr: () => multi, pexpire: () => multi, exec: async () => results };
    (globalThis as { replywiseLimiterRedis?: unknown }).replywiseLimiterRedis = {
      status: "ready",
      multi: () => multi,
    };
    return getLimiterStore();
  }
  afterEach(() => {
    delete (globalThis as { replywiseLimiterRedis?: unknown }).replywiseLimiterRedis;
  });

  it("returns the counter INCR reported", async () => {
    await expect(
      storeWith([
        [null, 3],
        [null, 1],
      ]).increment("k", 1_000),
    ).resolves.toBe(3);
  });

  it("fails closed when INCR reports an error or no result", async () => {
    await expect(
      storeWith([
        [new Error("WRONGTYPE"), null],
        [null, 1],
      ]).increment("k", 1_000),
    ).rejects.toThrow();
    await expect(storeWith(null).increment("k", 1_000)).rejects.toThrow();
  });
});
