import { deriveCategory } from "@replywise/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { aiUsageEvents } from "../schema/ai";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import {
  deleteAiCredential,
  getAiCredentialForUse,
  getAiCredentialSummary,
  getClassificationModel,
  getThreadForClassification,
  getThreadInsight,
  listThreadsPendingClassification,
  markAiCredentialInvalid,
  markThreadAnswered,
  recordAiUsage,
  saveAiCredential,
  setClassificationModel,
  summarizeAiUsage,
  upsertThreadInsight,
} from "./ai";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-23T12:00:00Z");
const since = new Date(now.getTime() - 7 * DAY);

async function validKey(userId: string) {
  await saveAiCredential(db, {
    userId,
    keyCiphertext: Buffer.from("ct"),
    keyHint: "abcd",
    status: "valid",
    lastValidatedAt: now,
  });
}

async function inboxThread(mailAccountId: string, at: Date, fromUser = false) {
  const thread = await insertThread(db, mailAccountId, {
    lastMessageAt: at,
    providerLabels: ["INBOX"],
  });
  const message = await insertMessage(db, thread.id, mailAccountId, {
    sentAt: at,
    isFromUser: fromUser,
  });
  return { thread, message };
}

describe("AI credentials", () => {
  it("saves, summarizes, replaces, invalidates and deletes a key per user", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    expect(await getAiCredentialSummary(db, alice.id)).toBeNull();
    await validKey(alice.id);
    await saveAiCredential(db, {
      userId: alice.id,
      keyCiphertext: Buffer.from("ct2"),
      keyHint: "wxyz",
      status: "valid",
      lastValidatedAt: now,
    });
    expect(await getAiCredentialSummary(db, alice.id)).toEqual({
      keyHint: "wxyz",
      status: "valid",
      lastValidatedAt: now,
    });
    expect((await getAiCredentialForUse(db, alice.id))?.keyCiphertext.toString()).toBe("ct2");
    expect(await getAiCredentialSummary(db, bob.id)).toBeNull();
    await markAiCredentialInvalid(db, alice.id);
    expect((await getAiCredentialSummary(db, alice.id))?.status).toBe("invalid");
    expect(await deleteAiCredential(db, alice.id)).toBe(true);
    expect(await deleteAiCredential(db, alice.id)).toBe(false);
  });

  it("only invalidates the key version the caller read", async () => {
    const alice = await insertUser(db);
    await validKey(alice.id); // key A (inserted: updated_at from the db default, µs precision)
    const versionA = (await getAiCredentialForUse(db, alice.id))?.updatedAt;
    expect(versionA).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 20));
    await saveAiCredential(db, {
      userId: alice.id,
      keyCiphertext: Buffer.from("ct-b"),
      keyHint: "bbbb",
      status: "valid",
      lastValidatedAt: now,
    }); // key B
    const versionB = (await getAiCredentialForUse(db, alice.id))?.updatedAt;
    expect(versionB?.getTime()).toBeGreaterThan(versionA?.getTime() ?? Number.POSITIVE_INFINITY);

    await markAiCredentialInvalid(db, alice.id, versionA);
    expect((await getAiCredentialSummary(db, alice.id))?.status).toBe("valid");
    await markAiCredentialInvalid(db, alice.id, versionB);
    expect((await getAiCredentialSummary(db, alice.id))?.status).toBe("invalid");
  });

  it("matches the version of a freshly inserted key despite µs precision", async () => {
    const alice = await insertUser(db);
    await validKey(alice.id);
    const version = (await getAiCredentialForUse(db, alice.id))?.updatedAt;
    await markAiCredentialInvalid(db, alice.id, version);
    expect((await getAiCredentialSummary(db, alice.id))?.status).toBe("invalid");
  });
});

describe("classification model preference", () => {
  it("defaults to Opus 5.5 and stores a choice", async () => {
    const alice = await insertUser(db);
    expect(await getClassificationModel(db, alice.id)).toBe("claude-opus-5-5");
    await setClassificationModel(db, alice.id, "claude-haiku-5-5");
    expect(await getClassificationModel(db, alice.id)).toBe("claude-haiku-5-5");
  });
});

describe("listThreadsPendingClassification", () => {
  it("lists recent inbox threads of users with a valid key whose newest message is new and not theirs", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    const fresh = await inboxThread(box.id, new Date(now.getTime() - DAY));
    await inboxThread(box.id, new Date(now.getTime() - 10 * DAY)); // too old
    await inboxThread(box.id, new Date(now.getTime() - DAY), true); // user replied last
    const archived = await insertThread(db, box.id, {
      lastMessageAt: new Date(now.getTime() - DAY),
      providerLabels: [],
    });
    await insertMessage(db, archived.id, box.id, { sentAt: new Date(now.getTime() - DAY) });

    expect(await listThreadsPendingClassification(db, since)).toEqual([]); // no key yet
    await validKey(alice.id);
    expect(await listThreadsPendingClassification(db, since)).toEqual([
      {
        threadId: fresh.thread.id,
        latestMessageId: fresh.message.id,
        credentialVersion: expect.any(Number),
      },
    ]);

    await upsertThreadInsight(db, {
      threadId: fresh.thread.id,
      category: "important",
      urgency: 2,
      importance: 4,
      needsReply: false,
      reasons: ["From your manager."],
      classifiedThroughMessageId: fresh.message.id,
      aiProvider: "anthropic",
      model: "claude-opus-5-5",
      promptVersion: "classify-v1",
    });
    expect(await listThreadsPendingClassification(db, since)).toEqual([]);

    const reply = await insertMessage(db, fresh.thread.id, box.id, { sentAt: now });
    expect(await listThreadsPendingClassification(db, since)).toEqual([
      {
        threadId: fresh.thread.id,
        latestMessageId: reply.id,
        credentialVersion: expect.any(Number),
      },
    ]);

    await markAiCredentialInvalid(db, alice.id);
    expect(await listThreadsPendingClassification(db, since)).toEqual([]);
  });
});

describe("listThreadsPendingClassification branches", () => {
  it("skips a thread whose newest message is from the user even if an older one is not", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    await validKey(alice.id);
    const thread = await insertThread(db, box.id, {
      lastMessageAt: new Date(now.getTime() - DAY),
      providerLabels: ["INBOX"],
    });
    await insertMessage(db, thread.id, box.id, {
      sentAt: new Date(now.getTime() - 2 * DAY),
      isFromUser: false,
    });
    await insertMessage(db, thread.id, box.id, {
      sentAt: new Date(now.getTime() - DAY),
      isFromUser: true,
    });
    expect(await listThreadsPendingClassification(db, since)).toEqual([]);
  });

  it("changes credentialVersion when the key is re-saved", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    await inboxThread(box.id, new Date(now.getTime() - DAY));
    await validKey(alice.id);
    const [first] = await listThreadsPendingClassification(db, since);
    await new Promise((r) => setTimeout(r, 20));
    await validKey(alice.id);
    const [second] = await listThreadsPendingClassification(db, since);
    expect(second?.credentialVersion).toBeGreaterThan(first?.credentialVersion ?? 0);
  });

  it("skips threads of mailboxes that are not active", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id, { status: "needs_reauth" });
    await validKey(alice.id);
    await inboxThread(box.id, new Date(now.getTime() - DAY));
    expect(await listThreadsPendingClassification(db, since)).toEqual([]);
  });

  it("only includes users with a valid key", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const aliceBox = await insertMailAccount(db, alice.id);
    const bobBox = await insertMailAccount(db, bob.id);
    const a = await inboxThread(aliceBox.id, new Date(now.getTime() - DAY));
    await inboxThread(bobBox.id, new Date(now.getTime() - DAY));
    await validKey(alice.id);
    expect(await listThreadsPendingClassification(db, since)).toEqual([
      {
        threadId: a.thread.id,
        latestMessageId: a.message.id,
        credentialVersion: expect.any(Number),
      },
    ]);
    await saveAiCredential(db, {
      userId: bob.id,
      keyCiphertext: Buffer.from("ct"),
      keyHint: "bbbb",
      status: "unverified",
      lastValidatedAt: null,
    });
    expect(await listThreadsPendingClassification(db, since)).toEqual([
      {
        threadId: a.thread.id,
        latestMessageId: a.message.id,
        credentialVersion: expect.any(Number),
      },
    ]);
  });
});

describe("insights, classification source and usage", () => {
  it("upserts one insight per thread and reads it back", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    const { thread, message } = await inboxThread(box.id, now);
    const base = {
      threadId: thread.id,
      urgency: 5,
      importance: 3,
      needsReply: true,
      reasons: ["Deadline is today."],
      classifiedThroughMessageId: message.id,
      aiProvider: "anthropic" as const,
      model: "claude-opus-5-5",
      promptVersion: "classify-v1",
    };
    await upsertThreadInsight(db, { ...base, category: "urgent" });
    await upsertThreadInsight(db, { ...base, category: "needs_reply", urgency: 2 });
    expect(await getThreadInsight(db, thread.id)).toMatchObject({
      category: "needs_reply",
      urgency: 2,
      importance: 3,
      needsReply: true,
      reasons: ["Deadline is today."],
      classifiedThroughMessageId: message.id,
      model: "claude-opus-5-5",
    });
  });

  it("markThreadAnswered clears needs_reply with a category matching deriveCategory", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    const { thread, message } = await inboxThread(box.id, now);
    for (let urgency = 1; urgency <= 5; urgency++) {
      for (let importance = 1; importance <= 5; importance++) {
        await upsertThreadInsight(db, {
          threadId: thread.id,
          category: deriveCategory({ urgency, importance, needsReply: true }),
          urgency,
          importance,
          needsReply: true,
          reasons: ["Asks a question."],
          classifiedThroughMessageId: message.id,
          aiProvider: "anthropic",
          model: "claude-opus-5-5",
          promptVersion: "classify-v1",
        });
        await markThreadAnswered(db, thread.id);
        const insight = await getThreadInsight(db, thread.id);
        expect({ urgency, importance, ...insight }).toMatchObject({
          urgency,
          importance,
          needsReply: false,
          category: deriveCategory({ urgency, importance, needsReply: false }),
          classifiedThroughMessageId: message.id,
        });
      }
    }
  });

  it("markThreadAnswered leaves insights without needs_reply and missing insights alone", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    const { thread, message } = await inboxThread(box.id, now);
    await markThreadAnswered(db, thread.id); // no insight: no-op
    expect(await getThreadInsight(db, thread.id)).toBeNull();
    await upsertThreadInsight(db, {
      threadId: thread.id,
      category: "important", // deliberately not what deriveCategory would give for 1/1
      urgency: 1,
      importance: 1,
      needsReply: false,
      reasons: [],
      classifiedThroughMessageId: message.id,
      aiProvider: "anthropic",
      model: "claude-opus-5-5",
      promptVersion: "classify-v1",
    });
    const before = await getThreadInsight(db, thread.id);
    await markThreadAnswered(db, thread.id);
    expect(await getThreadInsight(db, thread.id)).toEqual(before);
  });

  it("loads a thread with its owner, mailbox and messages oldest first", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id, { emailAddress: "alice@gmail.com" });
    const thread = await insertThread(db, box.id, { subject: "Hello", providerLabels: ["INBOX"] });
    const second = await insertMessage(db, thread.id, box.id, { sentAt: now });
    const first = await insertMessage(db, thread.id, box.id, {
      sentAt: new Date(now.getTime() - DAY),
    });
    const source = await getThreadForClassification(db, thread.id);
    expect(source?.userId).toBe(alice.id);
    expect(source?.mailboxEmail).toBe("alice@gmail.com");
    expect(source?.thread).toMatchObject({
      id: thread.id,
      subject: "Hello",
      mailAccountId: box.id,
    });
    expect(source?.messages.map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it("sums usage per task and model since a date", async () => {
    const alice = await insertUser(db);
    const event = {
      userId: alice.id,
      mailAccountId: null,
      task: "classify" as const,
      aiProvider: "anthropic" as const,
      model: "claude-opus-5-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
    };
    await recordAiUsage(db, event);
    await recordAiUsage(db, event);
    expect(await summarizeAiUsage(db, alice.id, since)).toEqual([
      {
        task: "classify",
        model: "claude-opus-5-5",
        calls: 2,
        inputTokens: 2000,
        outputTokens: 400,
        cacheReadTokens: 100,
      },
    ]);
  });

  it("excludes other users' events and events before since", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const event = {
      mailAccountId: null,
      task: "classify" as const,
      aiProvider: "anthropic" as const,
      model: "claude-opus-5-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
    };
    await recordAiUsage(db, { ...event, userId: alice.id });
    await recordAiUsage(db, { ...event, userId: bob.id });
    await db
      .insert(aiUsageEvents)
      .values({ ...event, userId: alice.id, createdAt: new Date(since.getTime() - DAY) });
    const rows = await summarizeAiUsage(db, alice.id, since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
    });
  });
});
