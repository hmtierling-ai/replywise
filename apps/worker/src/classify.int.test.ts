import { AiKeyInvalidError, AiRateLimitedError, AiRefusalError } from "@replywise/ai";
import { createFakeAiProvider } from "@replywise/ai/testing";
import { aad, createEncryptor, LocalKeyProvider } from "@replywise/crypto";
import {
  getAiCredentialSummary,
  getThreadInsight,
  listThreadsPendingClassification,
  markAiCredentialInvalid,
  messages,
  saveAiCredential,
  summarizeAiUsage,
} from "@replywise/db";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "@replywise/db/testing";
import { testEncryptor } from "@replywise/mailbox/testing";
import { createLogger } from "@replywise/observability";
import type { JobQueue } from "@replywise/queue";
import { encryptBody } from "@replywise/sync";
import { UnrecoverableError } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyThreadHandler } from "./jobs/classify-thread";
import { enqueueClassificationsHandler } from "./jobs/enqueue-classifications";

let handle: Awaited<ReturnType<typeof setupTestDb>>;
const encryptor = testEncryptor();
const logger = createLogger({ name: "test", level: "silent" });
const ctx = { jobId: "t", attempt: 1 };
const HOUR_MS = 3_600_000;

beforeAll(async () => {
  handle = await setupTestDb();
  // Leftovers from an aborted run would make every insert fail.
  await handle.db.execute(sql`alter table ai_usage_events drop constraint if exists t6_fail`);
  await handle.db.execute(sql`alter table thread_insights drop constraint if exists f4_fail`);
});
afterAll(async () => handle.close());
beforeEach(async () => resetTestDb(handle.db));

async function seed() {
  const { db } = handle;
  const alice = await insertUser(db, { name: "Alice" });
  const account = await insertMailAccount(db, alice.id, { emailAddress: "alice@gmail.com" });
  const thread = await insertThread(db, account.id, {
    subject: "Contract",
    providerLabels: ["INBOX"],
    lastMessageAt: new Date(Date.now() - 2 * HOUR_MS),
  });
  const m1 = await insertMessage(db, thread.id, account.id, {
    fromAddress: { name: "Client", address: "client@example.com" },
    sentAt: new Date(Date.now() - 2 * HOUR_MS),
    snippet: "snippet-only preview",
  });
  await db
    .update(messages)
    .set({
      bodyCiphertext: await encryptBody(encryptor, m1.id, {
        text: "Can you sign by Friday?\n> old quote",
        html: null,
      }),
    })
    .where(eq(messages.id, m1.id));
  await saveAiCredential(db, {
    userId: alice.id,
    keyCiphertext: await encryptor.encrypt(
      "sk-ant-test-key",
      aad.aiCredential(alice.id, "anthropic"),
    ),
    keyHint: "-key",
    status: "valid",
    lastValidatedAt: new Date(),
  });
  return { alice, account, thread, m1 };
}

describe("classifyThreadHandler", () => {
  it("classifies with the user's key and model, stores the insight and records usage", async () => {
    const { db } = handle;
    const { alice, thread, m1 } = await seed();
    const ai = createFakeAiProvider({
      result: {
        urgency: 4,
        importance: 5,
        needsReply: true,
        reasons: ["Client asks for a signature."],
      },
    });
    await classifyThreadHandler({ db, encryptor, ai, logger })(
      { threadId: thread.id, messageId: m1.id },
      ctx,
    );
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.apiKey).toBe("sk-ant-test-key");
    expect(ai.calls[0]?.model).toBe("claude-opus-5-5");
    expect(ai.calls[0]?.input.messages[0]?.text).toBe("Can you sign by Friday?");
    expect(await getThreadInsight(db, thread.id)).toMatchObject({
      category: "urgent",
      urgency: 4,
      importance: 5,
      needsReply: true,
      reasons: ["Client asks for a signature."],
      classifiedThroughMessageId: m1.id,
    });
    const usage = await summarizeAiUsage(db, alice.id, new Date(0));
    expect(usage).toEqual([
      expect.objectContaining({ task: "classify", calls: 1, inputTokens: 1200, outputTokens: 150 }),
    ]);
  });

  it("skips threads already classified through their newest message, or whose newest message is the user's", async () => {
    const { db } = handle;
    const { account, thread, m1 } = await seed();
    const ai = createFakeAiProvider();
    const handler = classifyThreadHandler({ db, encryptor, ai, logger });
    await handler({ threadId: thread.id, messageId: m1.id }, ctx);
    await handler({ threadId: thread.id, messageId: m1.id }, ctx);
    expect(ai.calls).toHaveLength(1);
    await insertMessage(db, thread.id, account.id, {
      isFromUser: true,
      fromAddress: { name: "Alice", address: "alice@gmail.com" },
      sentAt: new Date(Date.now() - HOUR_MS),
    });
    await handler({ threadId: thread.id, messageId: m1.id }, ctx);
    expect(ai.calls).toHaveLength(1);
  });

  it("marks the key invalid and fails permanently when the provider rejects it", async () => {
    const { db } = handle;
    const { alice, thread, m1 } = await seed();
    const ai = createFakeAiProvider({ error: new AiKeyInvalidError() });
    await expect(
      classifyThreadHandler({ db, encryptor, ai, logger })(
        { threadId: thread.id, messageId: m1.id },
        ctx,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getAiCredentialSummary(db, alice.id))?.status).toBe("invalid");
  });

  it("does nothing without a valid key", async () => {
    const { db } = handle;
    const { alice, thread, m1 } = await seed();
    await markAiCredentialInvalid(db, alice.id);
    const ai = createFakeAiProvider();
    await classifyThreadHandler({ db, encryptor, ai, logger })(
      { threadId: thread.id, messageId: m1.id },
      ctx,
    );
    expect(ai.calls).toHaveLength(0);
    expect(await getThreadInsight(db, thread.id)).toBeNull();
  });
});

describe("enqueueClassificationsHandler", () => {
  it("enqueues one deduplicated thread.classify job per pending thread", async () => {
    const { db } = handle;
    const { thread, m1 } = await seed();
    const enqueued: Array<{ name: string; payload: unknown; jobId?: string }> = [];
    const queue = {
      async enqueue(name: string, payload: unknown, options?: { jobId?: string }) {
        enqueued.push({ name, payload, ...(options?.jobId ? { jobId: options.jobId } : {}) });
      },
    } as unknown as JobQueue;
    await enqueueClassificationsHandler({ db, queue, logger })({}, ctx);
    const first = await listThreadsPendingClassification(db, new Date(0));
    expect(first).toHaveLength(1);
    expect(enqueued).toEqual([
      {
        name: "thread.classify",
        payload: { threadId: thread.id, messageId: m1.id },
        jobId: `classify_${thread.id}_${m1.id}_${first[0]?.credentialVersion}`,
      },
    ]);
  });

  it("produces a new job id after the key is re-saved", async () => {
    const { db } = handle;
    const { alice } = await seed();
    const ids: string[] = [];
    const queue = {
      async enqueue(_name: string, _payload: unknown, options?: { jobId?: string }) {
        ids.push(options?.jobId ?? "");
      },
    } as unknown as JobQueue;
    const scan = enqueueClassificationsHandler({ db, queue, logger });
    await scan({}, ctx);
    await new Promise((r) => setTimeout(r, 20));
    await saveAiCredential(db, {
      userId: alice.id,
      keyCiphertext: await encryptor.encrypt(
        "sk-ant-test-key",
        aad.aiCredential(alice.id, "anthropic"),
      ),
      keyHint: "-key",
      status: "valid",
      lastValidatedAt: new Date(),
    });
    await scan({}, ctx);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });
});

describe("classifyThreadHandler errors and guards", () => {
  it("rethrows a retryable AI error as it is", async () => {
    const { db } = handle;
    const { thread, m1 } = await seed();
    const error = new AiRateLimitedError();
    const ai = createFakeAiProvider({ error });
    await expect(
      classifyThreadHandler({ db, encryptor, ai, logger })(
        { threadId: thread.id, messageId: m1.id },
        ctx,
      ),
    ).rejects.toBe(error);
  });

  it("turns a refusal into a permanent failure carrying only the error name", async () => {
    const { db } = handle;
    const { thread, m1 } = await seed();
    const ai = createFakeAiProvider({ error: new AiRefusalError() });
    const rejection = await classifyThreadHandler({ db, encryptor, ai, logger })(
      { threadId: thread.id, messageId: m1.id },
      ctx,
    ).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect((rejection as Error).message).toBe("AiRefusalError");
  });

  it("sanitizes unknown errors before they reach BullMQ", async () => {
    const { db } = handle;
    const { thread, m1 } = await seed();
    const ai = createFakeAiProvider({
      error: new Error('Failed query: insert into "thread_insights" params: secret subject'),
    });
    const rejection = await classifyThreadHandler({ db, encryptor, ai, logger })(
      { threadId: thread.id, messageId: m1.id },
      ctx,
    ).catch((e: unknown) => e);
    // The handler maps a non-AI provider error to an UnrecoverableError named after the error.
    expect(rejection).toBeInstanceOf(Error);
    const text = `${(rejection as Error).message}\n${(rejection as Error).stack}`;
    expect(text).not.toContain("secret subject");
  });

  it("sanitizes errors thrown outside the provider call", async () => {
    const { db } = handle;
    const { thread, m1 } = await seed();
    const wrongKeyEncryptor = createEncryptor(
      LocalKeyProvider.fromEnv(`v1:${Buffer.alloc(32, 9).toString("base64")}`),
    );
    const ai = createFakeAiProvider();
    const rejection = await classifyThreadHandler({
      db,
      encryptor: wrongKeyEncryptor,
      ai,
      logger,
    })({ threadId: thread.id, messageId: m1.id }, ctx).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(Error);
    expect(ai.calls).toHaveLength(0);
    expect((rejection as Error).message).not.toContain("secret");
  });

  it("swallows an onUsage failure and still classifies", async () => {
    const { db } = handle;
    const { thread, m1 } = await seed();
    const lines: string[] = [];
    const capture = createLogger({ name: "test" }, { write: (l: string) => void lines.push(l) });
    const ai = createFakeAiProvider();
    // A CHECK that always fails makes every new usage row violate it (existing rows are not scanned).
    await db.execute(
      sql`alter table ai_usage_events add constraint t6_fail check (false) not valid`,
    );
    try {
      await classifyThreadHandler({ db, encryptor, ai, logger: capture })(
        { threadId: thread.id, messageId: m1.id },
        ctx,
      );
    } finally {
      await db.execute(sql`alter table ai_usage_events drop constraint if exists t6_fail`);
    }
    expect(await getThreadInsight(db, thread.id)).toMatchObject({
      classifiedThroughMessageId: m1.id,
    });
    expect(lines.join("")).toContain("ai usage not recorded");
  });

  it("pays once when the insight write keeps failing, then fails permanently", async () => {
    const { db } = handle;
    const { alice, thread, m1 } = await seed();
    const ai = createFakeAiProvider();
    // Every new insight row violates this CHECK (NOT VALID: existing rows are not scanned).
    await db.execute(
      sql`alter table thread_insights add constraint f4_fail check (false) not valid`,
    );
    let rejection: unknown;
    try {
      rejection = await classifyThreadHandler({ db, encryptor, ai, logger })(
        { threadId: thread.id, messageId: m1.id },
        ctx,
      ).catch((e: unknown) => e);
    } finally {
      await db.execute(sql`alter table thread_insights drop constraint if exists f4_fail`);
    }
    expect(ai.calls).toHaveLength(1);
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect((rejection as Error).message).toBe("InsightWriteFailed");
    const [usage] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ai_usage_events where user_id = ${alice.id}`,
    );
    expect(usage?.n).toBe(1);
    expect(await getThreadInsight(db, thread.id)).toBeNull();
  });

  it("does not invalidate a key the user replaced while the rejected call ran", async () => {
    const { db } = handle;
    const { alice, thread, m1 } = await seed();
    const rejecting = createFakeAiProvider({ error: new AiKeyInvalidError() });
    const ai = {
      ...rejecting,
      async classify(...args: Parameters<typeof rejecting.classify>) {
        await new Promise((r) => setTimeout(r, 20));
        await saveAiCredential(db, {
          userId: alice.id,
          keyCiphertext: await encryptor.encrypt(
            "sk-ant-new-key",
            aad.aiCredential(alice.id, "anthropic"),
          ),
          keyHint: "-new",
          status: "valid",
          lastValidatedAt: new Date(),
        });
        return rejecting.classify(...args);
      },
    };
    await expect(
      classifyThreadHandler({ db, encryptor, ai, logger })(
        { threadId: thread.id, messageId: m1.id },
        ctx,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await getAiCredentialSummary(db, alice.id)).toMatchObject({
      keyHint: "-new",
      status: "valid",
    });
  });

  it("skips a job whose messageId is not the newest message", async () => {
    const { db } = handle;
    const { account, thread, m1 } = await seed();
    await insertMessage(db, thread.id, account.id, {
      fromAddress: { name: "Client", address: "client@example.com" },
      sentAt: new Date(Date.now() - HOUR_MS),
    });
    const ai = createFakeAiProvider();
    await classifyThreadHandler({ db, encryptor, ai, logger })(
      { threadId: thread.id, messageId: m1.id },
      ctx,
    );
    expect(ai.calls).toHaveLength(0);
  });
});
