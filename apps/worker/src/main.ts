import type { WorkerEnv } from "@replywise/config";
import { createDb } from "@replywise/db";
import type { GmailApiFactory } from "@replywise/mail";
import type { Logger } from "@replywise/observability";
import { createJobQueue, createJobWorker, createRedisConnection } from "@replywise/queue";
import type { Worker } from "bullmq";
import { buildSyncDeps } from "./deps";
import { purgeBodiesHandler } from "./jobs/purge-bodies";
import { purgeOAuthStatesHandler } from "./jobs/purge-oauth-states";
import { reconcileSyncSchedulesHandler } from "./jobs/reconcile-sync-schedules";
import { syncMailboxHandler } from "./jobs/sync-mailbox";
import { safeErrorFields } from "./log-error";

export const PURGE_BODIES_SCHEDULER_ID = "maintenance.purgeBodies:hourly";
export const PURGE_OAUTH_STATES_SCHEDULER_ID = "maintenance.purgeOAuthStates:hourly";
export const RECONCILE_SCHEDULER_ID = "maintenance.reconcileSyncSchedules:minutely";
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const SYNC_CONCURRENCY = 4;

export async function startWorker(
  env: WorkerEnv,
  logger: Logger,
  options: { queuePrefix?: string; gmail?: GmailApiFactory } = {},
) {
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  const queueConnection = createRedisConnection(env.REDIS_URL);
  const maintenanceConnection = createRedisConnection(env.REDIS_URL);
  const syncConnection = createRedisConnection(env.REDIS_URL);
  const prefix = options.queuePrefix ? { prefix: options.queuePrefix } : {};
  const queue = createJobQueue(queueConnection, prefix);
  const syncDeps = buildSyncDeps(env, db, options.gmail);

  const maintenanceWorker = createJobWorker(
    "maintenance",
    maintenanceConnection,
    {
      "maintenance.purgeBodies": purgeBodiesHandler({ db, logger }),
      "maintenance.purgeOAuthStates": purgeOAuthStatesHandler({ db, logger }),
      "maintenance.reconcileSyncSchedules": reconcileSyncSchedulesHandler({ db, queue, logger }),
    },
    { concurrency: 1, ...prefix },
  );
  const syncWorker = createJobWorker(
    "sync",
    syncConnection,
    { "mailbox.sync": syncMailboxHandler({ syncDeps, logger }) },
    { concurrency: SYNC_CONCURRENCY, ...prefix },
  );
  for (const worker of [maintenanceWorker, syncWorker] as Worker[]) {
    worker.on("failed", (job, error) => {
      logger.error(
        { jobId: job?.id, jobName: job?.name, error: safeErrorFields(error) },
        "job failed",
      );
    });
  }

  await queue.scheduleRepeating(
    PURGE_BODIES_SCHEDULER_ID,
    "maintenance.purgeBodies",
    {},
    ONE_HOUR_MS,
  );
  await queue.scheduleRepeating(
    PURGE_OAUTH_STATES_SCHEDULER_ID,
    "maintenance.purgeOAuthStates",
    {},
    ONE_HOUR_MS,
  );
  await queue.scheduleRepeating(
    RECONCILE_SCHEDULER_ID,
    "maintenance.reconcileSyncSchedules",
    {},
    ONE_MINUTE_MS,
  );
  logger.info("worker started");

  return {
    async stop(): Promise<void> {
      await Promise.all([maintenanceWorker.close(), syncWorker.close()]);
      await queue.close();
      await Promise.all([
        queueConnection.quit(),
        maintenanceConnection.quit(),
        syncConnection.quit(),
      ]);
      await closeDb();
      logger.info("worker stopped");
    },
  };
}
