import type { WorkerEnv } from "@replywise/config";
import { createDb } from "@replywise/db";
import type { Logger } from "@replywise/observability";
import { createJobQueue, createJobWorker, createRedisConnection } from "@replywise/queue";
import { purgeBodiesHandler } from "./jobs/purge-bodies";
import { purgeOAuthStatesHandler } from "./jobs/purge-oauth-states";

export const PURGE_BODIES_SCHEDULER_ID = "maintenance.purgeBodies:hourly";
export const PURGE_OAUTH_STATES_SCHEDULER_ID = "maintenance.purgeOAuthStates:hourly";
const ONE_HOUR_MS = 60 * 60 * 1000;

export async function startWorker(
  env: WorkerEnv,
  logger: Logger,
  options: { queuePrefix?: string } = {},
) {
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  const queueConnection = createRedisConnection(env.REDIS_URL);
  const workerConnection = createRedisConnection(env.REDIS_URL);
  const prefix = options.queuePrefix ? { prefix: options.queuePrefix } : {};

  const queue = createJobQueue(queueConnection, prefix);
  const maintenanceWorker = createJobWorker(
    "maintenance",
    workerConnection,
    {
      "maintenance.purgeBodies": purgeBodiesHandler({ db, logger }),
      "maintenance.purgeOAuthStates": purgeOAuthStatesHandler({ db, logger }),
    },
    { concurrency: 1, ...prefix },
  );
  maintenanceWorker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, error: { name: error.name, message: error.message } },
      "job failed",
    );
  });

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
  logger.info("worker started");

  return {
    async stop(): Promise<void> {
      await maintenanceWorker.close();
      await queue.close();
      await Promise.all([queueConnection.quit(), workerConnection.quit()]);
      await closeDb();
      logger.info("worker stopped");
    },
  };
}
