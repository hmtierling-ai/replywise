import {
  type Db,
  expireScheduledSends,
  failStuckSends,
  listOverdueScheduledSends,
} from "@replywise/db";
import type { Logger } from "@replywise/observability";
import { type JobQueue, sendJobId } from "@replywise/queue";
import { writeSendAudit } from "./send-audit";

/**
 * Minutely (spec M6 §2.2 step 5): re-enqueue scheduled sends whose delayed job was lost (same job
 * id; the claim keeps the send single), and fail sends that will never finish. Never re-sends:
 * a `sending` row is only ever failed here, never enqueued again.
 */
export function recoverSendsHandler(deps: {
  db: Db;
  queue: JobQueue;
  logger: Logger;
  now?: () => Date;
}) {
  return async (_payload?: unknown, _context?: unknown): Promise<void> => {
    const now = deps.now?.() ?? new Date();
    const overdue = await listOverdueScheduledSends(deps.db, now);
    for (const { draftId, sendAt } of overdue) {
      await deps.queue.enqueue("draft.send", { draftId }, { jobId: sendJobId(draftId, sendAt) });
    }
    const failed = [
      ...(await expireScheduledSends(deps.db, now)),
      ...(await failStuckSends(deps.db, now)),
    ];
    for (const { userId, draftId, threadId, mailAccountId, error } of failed) {
      await writeSendAudit(deps, userId, "draft.send_failed", {
        draftId,
        threadId,
        mailAccountId,
        error,
      });
    }
    if (overdue.length > 0 || failed.length > 0) {
      deps.logger.info({ requeued: overdue.length, failed: failed.length }, "send recovery");
    }
  };
}
