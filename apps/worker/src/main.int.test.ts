import { randomUUID } from "node:crypto";
import { messages } from "@replywise/db";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
  TEST_DATABASE_URL,
} from "@replywise/db/testing";
import { createLogger } from "@replywise/observability";
import { createRedisConnection } from "@replywise/queue";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeBodiesHandler } from "./jobs/purge-bodies";
import { PURGE_BODIES_SCHEDULER_ID, startWorker } from "./main";

const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6379";
const silentLogger = () => {
  const lines: string[] = [];
  return {
    logger: createLogger({ name: "test" }, { write: (l: string) => void lines.push(l) }),
    lines,
  };
};

let handle: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  handle = await setupTestDb();
});
afterAll(async () => handle.close());
beforeEach(async () => resetTestDb(handle.db));

describe("purgeBodiesHandler", () => {
  it("purges expired bodies and logs only the count", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    const message = await insertMessage(db, thread.id, account.id, {
      bodyCiphertext: Buffer.from("confidential body"),
      bodyExpiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    const { logger, lines } = silentLogger();

    await purgeBodiesHandler({ db, logger, now: () => new Date("2026-11-15T00:00:00Z") })();

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(row?.bodyCiphertext).toBeNull();
    expect(lines.join("")).toContain('"purged":1');
    expect(lines.join("")).not.toContain("confidential body");
  });
});

describe("startWorker", () => {
  it("registers the hourly purge scheduler and stops cleanly", async () => {
    const queuePrefix = `test-${randomUUID()}`;
    const { logger } = silentLogger();
    const worker = await startWorker(
      {
        NODE_ENV: "test",
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL,
        LOCAL_KEKS: `v1:${Buffer.alloc(32).toString("base64")}`,
        LOG_LEVEL: "info",
      },
      logger,
      { queuePrefix },
    );

    const connection = createRedisConnection(REDIS_URL);
    const inspector = new Queue("maintenance", { connection, prefix: queuePrefix });
    try {
      const schedulers = await inspector.getJobSchedulers();
      expect(schedulers.map((s) => s.key)).toContain(PURGE_BODIES_SCHEDULER_ID);
    } finally {
      await inspector.close();
      await connection.quit();
      await worker.stop();
    }
  });
});
