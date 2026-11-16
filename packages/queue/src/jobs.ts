import { z } from "zod";

export type QueueName = "sync" | "ai" | "maintenance";

/** Single source of truth for job names, their queue, and payload shape. Payloads carry ids only. */
export const jobDefinitions = {
  "maintenance.purgeBodies": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.purgeOAuthStates": { queue: "maintenance", payload: z.object({}).strict() },
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
  close(): Promise<void>;
}

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(jobDefinitions, name);
}
