import { randomUUID } from "node:crypto";
import { aad } from "@replywise/crypto";
import { mailAccounts, mailOAuthStates, messages, threads } from "@replywise/db";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
  TEST_DATABASE_URL,
} from "@replywise/db/testing";
import { testEncryptor } from "@replywise/mailbox/testing";
import { createLogger } from "@replywise/observability";
import { createJobQueue, createRedisConnection } from "@replywise/queue";
import { createFakeGmail, fakeMessage } from "@replywise/sync/testing";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeBodiesHandler } from "./jobs/purge-bodies";
import { purgeOAuthStatesHandler } from "./jobs/purge-oauth-states";
import { reconcileSyncSchedulesHandler } from "./jobs/reconcile-sync-schedules";
import { syncMailboxHandler } from "./jobs/sync-mailbox";
import {
  ENQUEUE_CLASSIFICATIONS_SCHEDULER_ID,
  PURGE_BODIES_SCHEDULER_ID,
  PURGE_OAUTH_STATES_SCHEDULER_ID,
  RECONCILE_SCHEDULER_ID,
  RECOVER_SENDS_SCHEDULER_ID,
  startWorker,
} from "./main";

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

describe("purgeOAuthStatesHandler", () => {
  it("removes expired OAuth states and logs only the count", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    await db.insert(mailOAuthStates).values({
      stateHash: "expired",
      userId: user.id,
      provider: "gmail",
      codeVerifierCiphertext: Buffer.from("v"),
      returnTo: "/settings/mailboxes",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    const { logger, lines } = silentLogger();

    await purgeOAuthStatesHandler({ db, logger, now: () => new Date("2026-11-16T00:00:00Z") })();

    expect(await db.select().from(mailOAuthStates)).toHaveLength(0);
    expect(lines.join("")).toContain('"purged":1');
  });
});

describe("reconcileSyncSchedulesHandler", () => {
  it("schedules active Gmail mailboxes and removes schedules for the rest", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    const active = await insertMailAccount(db, user.id);
    await insertMailAccount(db, user.id, { status: "needs_reauth" });
    await insertMailAccount(db, user.id, { provider: "outlook" });
    const connection = createRedisConnection(REDIS_URL);
    const queue = createJobQueue(connection, { prefix: `test-${randomUUID()}` });
    const stale = "00000000-0000-4000-8000-0000000000ff";
    await queue.scheduleRepeating(
      `mailbox.sync:${stale}`,
      "mailbox.sync",
      { mailAccountId: stale },
      120_000,
    );
    const { logger } = silentLogger();
    try {
      await reconcileSyncSchedulesHandler({ db, queue, logger })();
      expect(await queue.listRepeating("sync")).toEqual([`mailbox.sync:${active.id}`]);
    } finally {
      await queue.close();
      await connection.quit();
    }
  });
});

describe("syncMailboxHandler", () => {
  it("syncs a mailbox and logs only the outcome", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const encryptor = testEncryptor();
    const account = await insertMailAccount(db, user.id);
    const blob = await encryptor.encrypt(
      JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt }),
      aad.mailTokens(account.id),
    );
    await db
      .update(mailAccounts)
      .set({ tokensCiphertext: blob })
      .where(eq(mailAccounts.id, account.id));
    const gmail = createFakeGmail({
      threads: { t1: [fakeMessage({ providerThreadId: "t1", bodyText: "private words" })] },
    });
    const { logger, lines } = silentLogger();

    await syncMailboxHandler({
      syncDeps: { db, encryptor, providers: {}, gmail: gmail.factory },
      logger,
    })({ mailAccountId: account.id });

    expect(await db.select().from(threads)).toHaveLength(1);
    expect(lines.join("")).toContain('"status":"synced"');
    expect(lines.join("")).not.toContain("private words");
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
      const ids = schedulers.map((s) => s.key);
      expect(ids).toContain(PURGE_BODIES_SCHEDULER_ID);
      expect(ids).toContain(PURGE_OAUTH_STATES_SCHEDULER_ID);
      expect(ids).toContain(RECONCILE_SCHEDULER_ID);
      expect(ids).toContain(ENQUEUE_CLASSIFICATIONS_SCHEDULER_ID);
      expect(ids).toContain(RECOVER_SENDS_SCHEDULER_ID);
    } finally {
      await inspector.close();
      await connection.quit();
      await worker.stop();
    }
  });
});
