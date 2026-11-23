import { type Db, listThreadsPendingClassification } from "@replywise/db";
import type { Logger } from "@replywise/observability";
import type { JobQueue } from "@replywise/queue";

/** User decision (2026-11-23): classify inbox threads whose last message is within 7 days. */
export const CLASSIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CLASSIFY_SCAN_LIMIT = 200;

export function enqueueClassificationsHandler(deps: {
  db: Db;
  queue: JobQueue;
  logger: Logger;
  now?: () => Date;
}) {
  return async (_payload?: unknown, _context?: unknown): Promise<void> => {
    const now = deps.now?.() ?? new Date();
    const pending = await listThreadsPendingClassification(
      deps.db,
      new Date(now.getTime() - CLASSIFY_WINDOW_MS),
      CLASSIFY_SCAN_LIMIT,
    );
    for (const { threadId, latestMessageId } of pending) {
      // BullMQ custom ids cannot contain ":". One job per (thread, newest message): a failed
      // job is not retried by the scan, and a new message gets a new id.
      await deps.queue.enqueue(
        "thread.classify",
        { threadId },
        { jobId: `classify_${threadId}_${latestMessageId}` },
      );
    }
    if (pending.length > 0)
      deps.logger.info({ pending: pending.length }, "classifications enqueued");
  };
}
