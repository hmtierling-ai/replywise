import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobQueue, createJobWorker, createRedisConnection } from "./bullmq";

const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6379";

let prefix: string;
let connections: Redis[];
const closers: Array<() => Promise<unknown>> = [];

function connection() {
  const c = createRedisConnection(REDIS_URL);
  connections.push(c);
  return c;
}

beforeEach(() => {
  prefix = `test-${randomUUID()}`;
  connections = [];
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(connections.map((c) => c.quit()));
});

describe("BullMQ job queue", () => {
  it("delivers a validated payload to the matching handler", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());

    const received = new Promise<unknown>((resolve) => {
      const worker = createJobWorker(
        "maintenance",
        connection(),
        { "maintenance.purgeBodies": async (payload) => resolve(payload) },
        { prefix },
      );
      closers.push(() => worker.close());
    });

    await queue.enqueue("maintenance.purgeBodies", {});
    await expect(received).resolves.toEqual({});
  });

  it("rejects an invalid payload at enqueue time", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await expect(
      queue.enqueue("maintenance.purgeBodies", { unexpected: true } as never),
    ).rejects.toThrow();
  });

  it("deduplicates jobs that share a jobId", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await queue.enqueue("maintenance.purgeBodies", {}, { jobId: "purge-once" });
    await queue.enqueue("maintenance.purgeBodies", {}, { jobId: "purge-once" });

    const inspector = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => inspector.close());
    expect((await inspector.getJobCounts("waiting")).waiting).toBe(1);
  });

  it("fails unknown job names without retrying", async () => {
    const raw = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => raw.close());

    const failure = new Promise<{ message: string; attempts: number }>((resolve) => {
      const worker = createJobWorker("maintenance", connection(), {}, { prefix });
      worker.on("failed", (job, error) =>
        resolve({ message: error.message, attempts: job?.attemptsMade ?? -1 }),
      );
      closers.push(() => worker.close());
    });

    await raw.add("maintenance.doesNotExist", {}, { attempts: 3 });
    const result = await failure;
    expect(result.message).toMatch(/Unknown job/);
    expect(result.attempts).toBe(1);
  });

  it("registers a repeating scheduler idempotently", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await queue.scheduleRepeating("purge-hourly", "maintenance.purgeBodies", {}, 3_600_000);
    await queue.scheduleRepeating("purge-hourly", "maintenance.purgeBodies", {}, 3_600_000);

    const inspector = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => inspector.close());
    const schedulers = await inspector.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual(["purge-hourly"]);
  });

  it("lists and removes job schedulers per queue", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    const id = "00000000-0000-4000-8000-000000000001";
    await queue.scheduleRepeating(
      `mailbox.sync:${id}`,
      "mailbox.sync",
      { mailAccountId: id },
      120_000,
    );
    expect(await queue.listRepeating("sync")).toEqual([`mailbox.sync:${id}`]);
    await queue.removeRepeating("sync", `mailbox.sync:${id}`);
    expect(await queue.listRepeating("sync")).toEqual([]);
  });

  it("rejects a mailbox.sync payload without a uuid", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await expect(queue.enqueue("mailbox.sync", { mailAccountId: "not-a-uuid" })).rejects.toThrow();
  });

  it("removes a delayed job by id and ignores unknown ids", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    const inspector = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => inspector.close());
    await queue.enqueue("maintenance.purgeBodies", {}, { jobId: "later", delayMs: 60_000 });
    expect(await inspector.getJob("later")).toBeTruthy();
    await queue.removeJob("maintenance", "later");
    expect(await inspector.getJob("later")).toBeFalsy();
    await expect(queue.removeJob("maintenance", "missing")).resolves.toBeUndefined();
  });
});
