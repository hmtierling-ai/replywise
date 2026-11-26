import { z } from "zod";

export type QueueName = "sync" | "ai" | "send" | "maintenance";

/** Single source of truth for job names, their queue, and payload shape. Payloads carry ids only. */
export const jobDefinitions = {
  "maintenance.purgeBodies": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.purgeOAuthStates": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.reconcileSyncSchedules": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.enqueueClassifications": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.recoverSends": { queue: "maintenance", payload: z.object({}).strict() },
  "thread.classify": {
    queue: "ai",
    payload: z.object({ threadId: z.uuid(), messageId: z.uuid() }).strict(),
  },
  "thread.summarize": { queue: "ai", payload: z.object({ threadId: z.uuid() }).strict() },
  "draft.generate": { queue: "ai", payload: z.object({ draftId: z.uuid() }).strict() },
  "draft.save": { queue: "ai", payload: z.object({ draftId: z.uuid() }).strict() },
  "draft.send": { queue: "send", payload: z.object({ draftId: z.uuid() }).strict() },
  "mailbox.sync": { queue: "sync", payload: z.object({ mailAccountId: z.uuid() }).strict() },
} as const satisfies Record<string, { queue: QueueName; payload: z.ZodType }>;

export type JobName = keyof typeof jobDefinitions;
export type JobPayload<N extends JobName> = z.output<(typeof jobDefinitions)[N]["payload"]>;

export interface JobContext {
  jobId: string | undefined;
  attempt: number;
}

export type JobHandlers = {
  [N in JobName]: (payload: JobPayload<N>, context: JobContext) => Promise<void>;
};

export interface EnqueueOptions {
  /** Jobs with the same id are deduplicated while one is pending. */
  jobId?: string;
  delayMs?: number;
}

export interface JobQueue {
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options?: EnqueueOptions,
  ): Promise<void>;
  scheduleRepeating<N extends JobName>(
    schedulerId: string,
    name: N,
    payload: JobPayload<N>,
    everyMs: number,
  ): Promise<void>;
  removeRepeating(queue: QueueName, schedulerId: string): Promise<void>;
  listRepeating(queue: QueueName): Promise<string[]>;
  /** Removes a waiting or delayed job. A no-op for missing jobs; active (locked) jobs stay. */
  removeJob(queue: QueueName, jobId: string): Promise<void>;
  close(): Promise<void>;
}

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(jobDefinitions, name);
}

/**
 * Job id of one confirmed send: undo removes it, and the stuck-send scan re-enqueues with the same
 * id so BullMQ dedupes it. BullMQ custom ids cannot contain ":".
 */
export function sendJobId(draftId: string, sendAt: Date): string {
  return `send_${draftId}_${sendAt.getTime()}`;
}
