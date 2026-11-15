import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { auditLogs, mailAccounts, messages, threadInsights, threads, users } from "./schema/index";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  pgErrorCode,
  resetTestDb,
  setupTestDb,
} from "./testing";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("mail_accounts", () => {
  it("rejects connecting the same mailbox twice for one user", async () => {
    const user = await insertUser(db);
    await insertMailAccount(db, user.id, { emailAddress: "me@gmail.com" });
    await expect(
      insertMailAccount(db, user.id, { emailAddress: "me@gmail.com" }),
    ).rejects.toSatisfy((error) => pgErrorCode(error) === "23505");
  });

  it("allows the same mailbox address for different users", async () => {
    const a = await insertUser(db);
    const b = await insertUser(db);
    await insertMailAccount(db, a.id, { emailAddress: "shared@gmail.com" });
    await expect(
      insertMailAccount(db, b.id, { emailAddress: "shared@gmail.com" }),
    ).resolves.toBeDefined();
  });

  it("stores encrypted blobs byte-for-byte", async () => {
    const user = await insertUser(db);
    const blob = Buffer.from([1, 0, 255, 128, 7]);
    const account = await insertMailAccount(db, user.id, { tokensCiphertext: blob });
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row?.tokensCiphertext.equals(blob)).toBe(true);
  });
});

describe("deleting a user", () => {
  it("cascades to mailboxes, threads and messages but keeps audit rows", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    await insertMessage(db, thread.id, account.id);
    await db.insert(auditLogs).values({ userId: user.id, action: "mailbox.connected" });

    await db.delete(users).where(eq(users.id, user.id));

    expect(await db.select().from(mailAccounts)).toHaveLength(0);
    expect(await db.select().from(threads)).toHaveLength(0);
    expect(await db.select().from(messages)).toHaveLength(0);
    const audit = await db.select().from(auditLogs);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.userId).toBeNull();
  });
});

describe("thread_insights", () => {
  it("enforces the 1-5 urgency range", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    const message = await insertMessage(db, thread.id, account.id);
    await expect(
      db.insert(threadInsights).values({
        threadId: thread.id,
        category: "urgent",
        urgency: 7,
        importance: 3,
        needsReply: true,
        reasons: ["Deadline today"],
        classifiedThroughMessageId: message.id,
        aiProvider: "anthropic",
        model: "claude-opus-5-5",
        promptVersion: "test",
      }),
    ).rejects.toSatisfy((error) => pgErrorCode(error) === "23514");
  });
});
