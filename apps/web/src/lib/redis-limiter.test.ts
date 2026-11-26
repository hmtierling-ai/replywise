import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@replywise/queue", () => ({ createProducerConnection: () => ({}) }));
vi.mock("./env", () => ({ getEnv: () => ({ REDIS_URL: "redis://x" }) }));

import { READY_TIMEOUT_MS, ready } from "./redis-limiter";

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
