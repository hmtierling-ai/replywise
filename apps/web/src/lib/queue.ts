import "server-only";
import { createJobQueue, createProducerConnection, type JobQueue } from "@replywise/queue";
import { getEnv } from "./env";

const globalForQueue = globalThis as unknown as { replywiseQueue?: JobQueue };

/** One producer connection per process; survives dev hot reloads. Web only enqueues and fails fast. */
export function getQueue(): JobQueue {
  globalForQueue.replywiseQueue ??= createJobQueue(createProducerConnection(getEnv().REDIS_URL));
  return globalForQueue.replywiseQueue;
}
