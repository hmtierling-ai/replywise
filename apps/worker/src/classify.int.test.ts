import { AiKeyInvalidError } from "@replywise/ai";
import { createFakeAiProvider } from "@replywise/ai/testing";
import { aad } from "@replywise/crypto";
import {
  getAiCredentialSummary,
  getThreadInsight,
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
import { eq } from "drizzle-orm";
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
    snippet: "Can you sign by Friday?",
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
    await classifyThreadHandler({ db, encryptor, ai, logger })({ threadId: thread.id }, ctx);
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
    const { account, thread } = await seed();
    const ai = createFakeAiProvider();
    const handler = classifyThreadHandler({ db, encryptor, ai, logger });
    await handler({ threadId: thread.id }, ctx);
    await handler({ threadId: thread.id }, ctx);
    expect(ai.calls).toHaveLength(1);
    await insertMessage(db, thread.id, account.id, {
      isFromUser: true,
      fromAddress: { name: "Alice", address: "alice@gmail.com" },
      sentAt: new Date(Date.now() - HOUR_MS),
    });
    await handler({ threadId: thread.id }, ctx);
    expect(ai.calls).toHaveLength(1);
  });

  it("marks the key invalid and fails permanently when the provider rejects it", async () => {
    const { db } = handle;
    const { alice, thread } = await seed();
    const ai = createFakeAiProvider({ error: new AiKeyInvalidError() });
    await expect(
      classifyThreadHandler({ db, encryptor, ai, logger })({ threadId: thread.id }, ctx),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getAiCredentialSummary(db, alice.id))?.status).toBe("invalid");
  });

  it("does nothing without a valid key", async () => {
    const { db } = handle;
    const { alice, thread } = await seed();
    await markAiCredentialInvalid(db, alice.id);
    const ai = createFakeAiProvider();
    await classifyThreadHandler({ db, encryptor, ai, logger })({ threadId: thread.id }, ctx);
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
    expect(enqueued).toEqual([
      {
        name: "thread.classify",
        payload: { threadId: thread.id },
        jobId: `classify_${thread.id}_${m1.id}`,
      },
    ]);
  });
});
