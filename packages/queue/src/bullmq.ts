import { type Job, Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  isJobName,
  type JobContext,
  type JobHandlers,
  type JobQueue,
  jobDefinitions,
  type QueueName,
} from "./jobs";

/** Attempts per job; handlers compare `JobContext.attempt` with it to detect the final try. */
export const JOB_ATTEMPTS = 5;

const DEFAULT_JOB_OPTIONS = {
  attempts: JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** BullMQ requires maxRetriesPerRequest: null for blocking worker connections. */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * Producer-only (web) connection: fails fast when Redis is down instead of hanging the request.
 * Do not use for workers, which need `createRedisConnection`.
 */
export function createProducerConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
}

export function createJobQueue(connection: Redis, options: { prefix?: string } = {}): JobQueue {
  const queues = new Map<QueueName, Queue>();
  const queueFor = (name: QueueName): Queue => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
        ...(options.prefix ? { prefix: options.prefix } : {}),
      });
      queues.set(name, queue);
    }
    return queue;
  };

  return {
    async enqueue(name, payload, enqueueOptions = {}) {
      const definition = jobDefinitions[name];
      const data = definition.payload.parse(payload);
      await queueFor(definition.queue).add(name, data, {
        ...(enqueueOptions.jobId ? { jobId: enqueueOptions.jobId } : {}),
        ...(enqueueOptions.delayMs ? { delay: enqueueOptions.delayMs } : {}),
      });
    },
    async scheduleRepeating(schedulerId, name, payload, everyMs) {
      const definition = jobDefinitions[name];
      await queueFor(definition.queue).upsertJobScheduler(
        schedulerId,
        { every: everyMs },
        { name, data: definition.payload.parse(payload) },
      );
    },
    async removeRepeating(queue, schedulerId) {
      await queueFor(queue).removeJobScheduler(schedulerId);
    },
    async listRepeating(queue) {
      const schedulers = await queueFor(queue).getJobSchedulers();
      return schedulers.map((s) => s.key).filter((key): key is string => typeof key === "string");
    },
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
    },
  };
}

export function createJobWorker(
  queue: QueueName,
  connection: Redis,
  handlers: Partial<JobHandlers>,
  options: { concurrency?: number; prefix?: string } = {},
): Worker {
  return new Worker(
    queue,
    async (job: Job) => {
      if (!isJobName(job.name) || jobDefinitions[job.name].queue !== queue) {
        throw new UnrecoverableError(`Unknown job "${job.name}" on queue "${queue}"`);
      }
      const handler = handlers[job.name] as
        | ((payload: unknown, context: JobContext) => Promise<void>)
        | undefined;
      if (!handler) throw new UnrecoverableError(`No handler registered for "${job.name}"`);
      const parsed = jobDefinitions[job.name].payload.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError(`Invalid payload for "${job.name}"`);
      await handler(parsed.data, { jobId: job.id, attempt: job.attemptsMade + 1 });
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );
}
