import "server-only";
import { createProducerConnection } from "@replywise/queue";
import { getEnv } from "./env";
import type { LimiterStore } from "./search-limit";

type Redis = ReturnType<typeof createProducerConnection>;
const globalForLimiter = globalThis as unknown as { replywiseLimiterRedis?: Redis };

export const READY_TIMEOUT_MS = 5_000;

interface ReadyTarget {
  status: string;
  once(event: "ready", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "ready", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * The producer connection has no offline queue, so a command sent while the first connection is
 * still being established would fail. Wait for it, bounded by a timeout; never hangs.
 */
export async function ready(redis: ReadyTarget): Promise<void> {
  if (redis.status === "ready") return;
  if (redis.status === "end") throw new Error("redis connection closed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onReady: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onReady = () => resolve();
      onError = (error) => reject(error);
      redis.once("ready", onReady);
      redis.once("error", onError);
      timer = setTimeout(() => reject(new Error("redis not ready in time")), READY_TIMEOUT_MS);
    });
  } finally {
    clearTimeout(timer);
    if (onReady) redis.off("ready", onReady);
    if (onError) redis.off("error", onError);
  }
}

/** Redis-backed limiter store: one fail-fast connection per process (survives dev reloads). */
export function getLimiterStore(): LimiterStore {
  globalForLimiter.replywiseLimiterRedis ??= createProducerConnection(getEnv().REDIS_URL);
  const redis = globalForLimiter.replywiseLimiterRedis;
  return {
    async setIfAbsent(key, ttlMs) {
      await ready(redis);
      return (await redis.set(key, "1", "PX", ttlMs, "NX")) === "OK";
    },
    async increment(key, ttlMs) {
      await ready(redis);
      const results = await redis.multi().incr(key).pexpire(key, ttlMs).exec();
      return Number(results?.[0]?.[1] ?? 0);
    },
    async remove(key) {
      await ready(redis);
      await redis.del(key);
    },
  };
}
