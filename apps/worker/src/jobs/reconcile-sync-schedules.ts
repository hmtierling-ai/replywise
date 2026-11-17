import { type Db, listSyncableMailAccounts } from "@replywise/db";
import type { Logger } from "@replywise/observability";
import type { JobQueue } from "@replywise/queue";

export const SYNC_INTERVAL_MS = 120_000;
export const syncSchedulerId = (mailAccountId: string) => `mailbox.sync:${mailAccountId}`;

/**
 * Keeps one 2-minute sync schedule per active Gmail mailbox and removes the rest
 * (disconnected, needing reauth, or unsupported providers).
 */
export function reconcileSyncSchedulesHandler(deps: { db: Db; queue: JobQueue; logger: Logger }) {
  return async (): Promise<void> => {
    const wanted = (await listSyncableMailAccounts(deps.db)).filter((m) => m.provider === "gmail");
    const wantedIds = new Set(wanted.map((m) => syncSchedulerId(m.id)));
    for (const mailbox of wanted) {
      await deps.queue.scheduleRepeating(
        syncSchedulerId(mailbox.id),
        "mailbox.sync",
        { mailAccountId: mailbox.id },
        SYNC_INTERVAL_MS,
      );
    }
    let removed = 0;
    for (const id of await deps.queue.listRepeating("sync")) {
      if (!wantedIds.has(id)) {
        await deps.queue.removeRepeating("sync", id);
        removed += 1;
      }
    }
    deps.logger.info({ scheduled: wanted.length, removed }, "reconciled sync schedules");
  };
}
