import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import { upsertThreadInsight } from "./ai";
import { getThreadForUser, listInboxThreads } from "./threads";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("listInboxThreads", () => {
  it("returns only the user's INBOX threads, newest first, with the mailbox address", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const mailbox = await insertMailAccount(db, alice.id, { emailAddress: "alice@gmail.com" });
    const other = await insertMailAccount(db, bob.id);
    await insertThread(db, mailbox.id, {
      providerThreadId: "old",
      subject: "Older",
      providerLabels: ["INBOX"],
      lastMessageAt: new Date("2026-11-01T00:00:00Z"),
    });
    await insertThread(db, mailbox.id, {
      providerThreadId: "new",
      subject: "Newer",
      providerLabels: ["INBOX", "UNREAD"],
      isUnread: true,
      lastMessageAt: new Date("2026-11-10T00:00:00Z"),
    });
    await insertThread(db, mailbox.id, { providerThreadId: "sent", providerLabels: ["SENT"] });
    await insertThread(db, other.id, { providerThreadId: "bob", providerLabels: ["INBOX"] });

    const list = await listInboxThreads(db, alice.id);
    expect(list.map((t) => t.subject)).toEqual(["Newer", "Older"]);
    expect(list[0]).toMatchObject({ isUnread: true, mailboxEmail: "alice@gmail.com" });
    expect(await listInboxThreads(db, alice.id, { limit: 1 })).toHaveLength(1);
  });
});

describe("listInboxThreads insights", () => {
  it("returns insight fields and filters by category", async () => {
    const alice = await insertUser(db);
    const mailbox = await insertMailAccount(db, alice.id);
    const urgentThread = await insertThread(db, mailbox.id, {
      providerThreadId: "u",
      providerLabels: ["INBOX"],
    });
    const urgentMessage = await insertMessage(db, urgentThread.id, mailbox.id);
    const otherThread = await insertThread(db, mailbox.id, {
      providerThreadId: "o",
      providerLabels: ["INBOX"],
    });
    await insertMessage(db, otherThread.id, mailbox.id);
    const urgentThreadId = urgentThread.id;
    const otherThreadId = otherThread.id;
    await upsertThreadInsight(db, {
      threadId: urgentThreadId,
      category: "urgent",
      urgency: 5,
      importance: 3,
      needsReply: true,
      reasons: ["Due today."],
      classifiedThroughMessageId: urgentMessage.id,
      aiProvider: "anthropic",
      model: "claude-opus-5-5",
      promptVersion: "classify-v1",
    });
    const all = await listInboxThreads(db, alice.id);
    expect(all.find((t) => t.id === urgentThreadId)).toMatchObject({
      category: "urgent",
      urgency: 5,
      importance: 3,
      reasons: ["Due today."],
    });
    expect(all.find((t) => t.id === otherThreadId)?.category).toBeNull();
    const urgent = await listInboxThreads(db, alice.id, { category: "urgent" });
    expect(urgent.map((t) => t.id)).toEqual([urgentThreadId]);
  });
});

describe("getThreadForUser", () => {
  it("returns the thread with messages oldest first, and nothing for other users", async () => {
    const alice = await insertUser(db);
    const mallory = await insertUser(db);
    const mailbox = await insertMailAccount(db, alice.id);
    const thread = await insertThread(db, mailbox.id, { subject: "Plans" });
    await insertMessage(db, thread.id, mailbox.id, {
      providerMessageId: "b",
      sentAt: new Date("2026-11-02T00:00:00Z"),
    });
    await insertMessage(db, thread.id, mailbox.id, {
      providerMessageId: "a",
      sentAt: new Date("2026-11-01T00:00:00Z"),
    });

    const detail = await getThreadForUser(db, alice.id, thread.id);
    expect(detail?.thread.subject).toBe("Plans");
    expect(detail?.mailbox).toMatchObject({ id: mailbox.id, provider: "gmail", status: "active" });
    expect(detail?.messages.map((m) => m.providerMessageId)).toEqual(["a", "b"]);
    expect(await getThreadForUser(db, mallory.id, thread.id)).toBeNull();
  });
});
