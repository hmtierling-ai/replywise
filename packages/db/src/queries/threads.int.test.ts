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
import {
  countThreadViews,
  getThreadForUser,
  listInboxThreads,
  listOtherThreads,
  listSentThreads,
} from "./threads";

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

describe("Other, Sent and view counts", () => {
  async function seedViews() {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    const bobBox = await insertMailAccount(db, bob.id);
    const day = (d: number) => new Date(`2026-11-${String(d).padStart(2, "0")}T00:00:00Z`);
    const plain = await insertThread(db, box.id, {
      subject: "Plain",
      providerLabels: ["INBOX"],
      lastMessageAt: day(20),
    });
    const plainMessage = await insertMessage(db, plain.id, box.id);
    const promo = await insertThread(db, box.id, {
      subject: "Promo",
      providerLabels: ["CATEGORY_PROMOTIONS", "INBOX"],
      lastMessageAt: day(21),
    });
    const promoMessage = await insertMessage(db, promo.id, box.id);
    const social = await insertThread(db, box.id, {
      subject: "Social",
      providerLabels: ["CATEGORY_SOCIAL", "INBOX"],
      lastMessageAt: day(22),
    });
    await insertMessage(db, social.id, box.id);
    // The user wrote in it: never Other, even with a tab label.
    const answered = await insertThread(db, box.id, {
      subject: "Answered update",
      providerLabels: ["CATEGORY_UPDATES", "INBOX", "SENT"],
      lastMessageAt: day(23),
    });
    await insertMessage(db, answered.id, box.id);
    await insertMessage(db, answered.id, box.id, { isFromUser: true });
    const sentOnly = await insertThread(db, box.id, {
      subject: "Sent only",
      providerLabels: ["SENT"],
      lastMessageAt: day(24),
    });
    await insertMessage(db, sentOnly.id, box.id, { isFromUser: true });
    const bobPromo = await insertThread(db, bobBox.id, {
      subject: "Bob promo",
      providerLabels: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    await insertMessage(db, bobPromo.id, bobBox.id);
    const insight = (
      threadId: string,
      messageId: string,
      category: "informational" | "low_priority",
    ) =>
      upsertThreadInsight(db, {
        threadId,
        category,
        urgency: 1,
        importance: category === "informational" ? 2 : 1,
        needsReply: false,
        reasons: ["r"],
        classifiedThroughMessageId: messageId,
        aiProvider: "anthropic",
        model: "claude-opus-5-5",
        promptVersion: "classify-v1",
      });
    await insight(plain.id, plainMessage.id, "informational");
    await insight(promo.id, promoMessage.id, "low_priority");
    return { alice, bob };
  }

  it("hides Other threads from the inbox and the AI tabs", async () => {
    const { alice } = await seedViews();
    expect((await listInboxThreads(db, alice.id)).map((t) => t.subject)).toEqual([
      "Answered update",
      "Plain",
    ]);
    expect(await listInboxThreads(db, alice.id, { category: "low_priority" })).toEqual([]);
    expect(
      (await listInboxThreads(db, alice.id, { category: "informational" })).map((t) => t.subject),
    ).toEqual(["Plain"]);
  });

  it("lists Other threads newest first, filtered by tab and scoped to the user", async () => {
    const { alice, bob } = await seedViews();
    expect((await listOtherThreads(db, alice.id)).map((t) => t.subject)).toEqual([
      "Social",
      "Promo",
    ]);
    expect(
      (await listOtherThreads(db, alice.id, { tab: "promotions" })).map((t) => t.subject),
    ).toEqual(["Promo"]);
    expect(await listOtherThreads(db, alice.id, { tab: "updates" })).toEqual([]);
    expect((await listOtherThreads(db, bob.id)).map((t) => t.subject)).toEqual(["Bob promo"]);
  });

  it("lists SENT threads", async () => {
    const { alice } = await seedViews();
    expect((await listSentThreads(db, alice.id)).map((t) => t.subject)).toEqual([
      "Sent only",
      "Answered update",
    ]);
  });

  it("counts views with the same rule", async () => {
    const { alice } = await seedViews();
    expect(await countThreadViews(db, alice.id)).toEqual({
      inbox: 2,
      other: 2,
      categories: {
        urgent: 0,
        important: 0,
        needs_reply: 0,
        informational: 1,
        low_priority: 0,
      },
    });
  });
});
