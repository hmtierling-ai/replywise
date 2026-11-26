import type { LimiterStore } from "./search-limit";

/** In-memory LimiterStore for unit tests (TTLs are ignored; tests move `now` instead). */
export function memoryStore(): LimiterStore & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    async setIfAbsent(key) {
      if (keys.has(key)) return false;
      keys.set(key, 1);
      return true;
    },
    async increment(key) {
      const next = (keys.get(key) ?? 0) + 1;
      keys.set(key, next);
      return next;
    },
    async remove(key) {
      keys.delete(key);
    },
  };
}
