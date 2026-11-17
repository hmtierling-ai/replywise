import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { mailAccounts, messages, threads, userPreferences } from "../schema/index";
import { insertMailAccount, insertUser, resetTestDb, setupTestDb } from "../testing";
import {
  acquireSyncLease,
  deleteMessagesByProviderIds,
  deleteMessagesNotIn,
  deleteThreadsByProviderIds,
  getBodyCacheDays,
  listSyncableMailAccounts,
  type MessageWrite,
  recordSyncFailure,
  recordSyncSuccess,
  releaseSyncLease,
  setMessageBody,
  type ThreadWrite,
  upsertMessage,
  upsertThread,
} from "./sync";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

const T0 = new Date("2026-11-17T12:00:00Z");
const thread = (overrides: Partial<ThreadWrite> = {}): ThreadWrite => ({
  providerThreadId: "t1",
  subject: "Hello",
  snippet: "First",
  participants: [{ name: "Ada", address: "ada@x.com" }],
  lastMessageAt: T0,
  messageCount: 1,
  isUnread: true,
  providerLabels: ["INBOX", "UNREAD"],
  ...overrides,
});
const message = (overrides: Partial<MessageWrite> = {}): MessageWrite => ({
  providerMessageId: "m1",
  internetMessageId: "<m1@x.com>",
  fromAddress: { name: "Ada", address: "ada@x.com" },
  toAddresses: [{ name: null, address: "me@gmail.com" }],
  ccAddresses: [],
  subject: "Hello",
  snippet: "First",
  sentAt: T0,
  isFromUser: false,
  hasAttachments: false,
  ...overrides,
});

describe("sync lease", () => {
  it("is exclusive until released or expired, and never granted to needs_reauth mailboxes", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    expect(await acquireSyncLease(db, account.id, T0, 600_000)).toBe(true);
    expect(await acquireSyncLease(db, account.id, T0, 600_000)).toBe(false);
    expect(await acquireSyncLease(db, account.id, new Date(T0.getTime() + 600_001), 600_000)).toBe(
      true,
    );
    await releaseSyncLease(db, account.id);
    expect(await acquireSyncLease(db, account.id, T0, 600_000)).toBe(true);

    const reauth = await insertMailAccount(db, user.id, { status: "needs_reauth" });
    expect(await acquireSyncLease(db, reauth.id, T0, 600_000)).toBe(false);
  });

  it("lists only active mailboxes as syncable", async () => {
    const user = await insertUser(db);
    const active = await insertMailAccount(db, user.id);
    await insertMailAccount(db, user.id, { status: "needs_reauth" });
    expect(await listSyncableMailAccounts(db)).toEqual([{ id: active.id, provider: "gmail" }]);
  });
});

describe("thread and message upserts", () => {
  it("are idempotent and update fields in place", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const id1 = await upsertThread(db, account.id, thread());
    const id2 = await upsertThread(db, account.id, thread({ snippet: "Second", messageCount: 2 }));
    expect(id2).toBe(id1);
    const [row] = await db.select().from(threads).where(eq(threads.id, id1));
    expect(row).toMatchObject({ snippet: "Second", messageCount: 2, isUnread: true });

    const m1 = await upsertMessage(db, id1, account.id, message());
    const m1again = await upsertMessage(db, id1, account.id, message({ snippet: "Edited" }));
    expect(m1again).toBe(m1);
    await upsertMessage(db, id1, account.id, message({ providerMessageId: "m2" }));
    expect(await deleteMessagesNotIn(db, id1, ["m2"])).toBe(1);
    expect((await db.select().from(messages)).map((m) => m.providerMessageId)).toEqual(["m2"]);
  });

  it("stores bodies and deletes by provider ids", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const threadId = await upsertThread(db, account.id, thread());
    const messageId = await upsertMessage(db, threadId, account.id, message());
    const expires = new Date(T0.getTime() + 86_400_000);
    await setMessageBody(db, messageId, Buffer.from([1, 2, 3]), expires);
    const [stored] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(stored?.bodyCiphertext?.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(stored?.bodyExpiresAt?.getTime()).toBe(expires.getTime());

    expect(await deleteMessagesByProviderIds(db, account.id, ["m1", "unknown"])).toBe(1);
    expect(await deleteThreadsByProviderIds(db, account.id, ["t1"])).toBe(1);
    expect(await db.select().from(threads)).toHaveLength(0);
    expect(await deleteThreadsByProviderIds(db, account.id, [])).toBe(0);
  });
});

describe("sync bookkeeping", () => {
  it("records success and failure without touching status", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    await recordSyncFailure(db, account.id, "Gmail API request failed (500)");
    let [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row).toMatchObject({ status: "active", lastError: "Gmail API request failed (500)" });
    await recordSyncSuccess(db, account.id, "777", T0);
    [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row).toMatchObject({ syncCursor: "777", lastError: null, status: "active" });
    expect(row?.lastSyncedAt?.getTime()).toBe(T0.getTime());
  });

  it("reads the body cache retention preference with a 14-day default", async () => {
    const user = await insertUser(db);
    expect(await getBodyCacheDays(db, user.id)).toBe(14);
    await db.insert(userPreferences).values({ userId: user.id, bodyCacheDays: 3 });
    expect(await getBodyCacheDays(db, user.id)).toBe(3);
  });
});
