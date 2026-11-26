/** Minimal Redis surface the limiter needs (injectable for tests). */
export interface LimiterStore {
  /** SET key NX with a TTL; true when this call created the key. */
  setIfAbsent(key: string, ttlMs: number): Promise<boolean>;
  /** INCR with a TTL; returns the new value. */
  increment(key: string, ttlMs: number): Promise<number>;
  remove(key: string): Promise<void>;
}

export const GMAIL_SEARCHES_PER_MINUTE = 30;
/** One search's upper bound; the lock expires by itself if a request dies. */
export const GMAIL_SEARCH_LOCK_MS = 30_000;
const MINUTE_MS = 60_000;

export type GmailSearchSlot = { ok: true; release: () => Promise<void> } | { ok: false };

/** Counts one Gmail request (search or import) in the user's current minute; false over the cap. */
export async function countGmailRequest(
  store: LimiterStore,
  userId: string,
  now: number,
): Promise<boolean> {
  const window = Math.floor(now / MINUTE_MS);
  const count = await store.increment(`rw:gmail-search:count:${userId}:${window}`, 2 * MINUTE_MS);
  return count <= GMAIL_SEARCHES_PER_MINUTE;
}

/** One in-flight Gmail search per user and at most 30 per minute (spec M6 §5.2). */
export async function acquireGmailSearchSlot(
  store: LimiterStore,
  userId: string,
  now: number,
): Promise<GmailSearchSlot> {
  const lock = `rw:gmail-search:lock:${userId}`;
  if (!(await store.setIfAbsent(lock, GMAIL_SEARCH_LOCK_MS))) return { ok: false };
  let allowed: boolean;
  try {
    allowed = await countGmailRequest(store, userId, now);
  } catch (error) {
    // The count failed closed; do not also lock the user out for GMAIL_SEARCH_LOCK_MS.
    await store.remove(lock).catch(() => undefined);
    throw error;
  }
  if (!allowed) {
    await store.remove(lock);
    return { ok: false };
  }
  return { ok: true, release: () => store.remove(lock) };
}
