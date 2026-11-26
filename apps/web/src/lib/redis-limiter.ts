import "server-only";
import { createProducerConnection } from "@replywise/queue";
import { getEnv } from "./env";
import type { LimiterStore } from "./search-limit";

type Redis = ReturnType<typeof createProducerConnection>;
const globalForLimiter = globalThis as unknown as { replywiseLimiterRedis?: Redis };

/**
 * The producer connection has no offline queue, so a command sent while the first connection is
 * still being established would fail. Wait for it (bounded by the connect timeout).
 */
async function ready(redis: Redis): Promise<void> {
  if (redis.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      redis.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      redis.off("ready", onReady);
      reject(error);
    };
    redis.once("ready", onReady);
    redis.once("error", onError);
  });
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
