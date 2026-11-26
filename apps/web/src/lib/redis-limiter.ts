import "server-only";
import { createProducerConnection } from "@replywise/queue";
import { getEnv } from "./env";
import type { LimiterStore } from "./search-limit";

type Redis = ReturnType<typeof createProducerConnection>;
const globalForLimiter = globalThis as unknown as { replywiseLimiterRedis?: Redis };

/** Redis-backed limiter store: one fail-fast connection per process (survives dev reloads). */
export function getLimiterStore(): LimiterStore {
  globalForLimiter.replywiseLimiterRedis ??= createProducerConnection(getEnv().REDIS_URL);
  const redis = globalForLimiter.replywiseLimiterRedis;
  return {
    async setIfAbsent(key, ttlMs) {
      return (await redis.set(key, "1", "PX", ttlMs, "NX")) === "OK";
    },
    async increment(key, ttlMs) {
      const results = await redis.multi().incr(key).pexpire(key, ttlMs).exec();
      return Number(results?.[0]?.[1] ?? 0);
    },
    async remove(key) {
      await redis.del(key);
    },
  };
}
