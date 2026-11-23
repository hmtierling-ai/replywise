import { aad } from "@replywise/crypto";
import { type Db, mailAccounts, messages, threads, userPreferences } from "@replywise/db";
import { insertMailAccount, insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { ProviderHttpError } from "@replywise/mail";
import { completeConnect, startConnect } from "@replywise/mailbox";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptBody } from "./body-codec";
import type { SyncDeps } from "./deps";
import { SyncDeadlineError } from "./errors";
import { syncMailbox } from "./sync-mailbox";
import { createFakeGmail, fakeMessage } from "./testing";

const T0 = new Date("2026-11-17T12:00:00Z");
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function connectedGmail(email = "me@gmail.com") {
  const provider = createFakeProvider("gmail", { email });
  const encryptor = testEncryptor();
  const base = { db, encryptor, providers: { gmail: provider.provider }, now: () => T0 };
  const user = await insertUser(db);
  const url = await startConnect(base, {
    userId: user.id,
    provider: "gmail",
    redirectUri: "http://cb",
  });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(base, {
    userId: user.id,
    provider: "gmail",
    code: "c",
    state,
    redirectUri: "http://cb",
  });
  return { base, userId: user.id, mailAccountId, encryptor, provider };
}

async function accountRow(mailAccountId: string) {
  const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
  return account;
}

function seedThreads(count: number): Record<string, ReturnType<typeof fakeMessage>[]> {
  const seeded: Record<string, ReturnType<typeof fakeMessage>[]> = {};
  for (let i = 0; i < count; i++) {
    seeded[`t${i}`] = [fakeMessage({ providerMessageId: `m${i}`, providerThreadId: `t${i}` })];
  }
  return seeded;
}

const storedThreadIds = async () =>
  (await db.select().from(threads)).map((t) => t.providerThreadId).sort();

function syncDeps(
  base: Omit<SyncDeps, "gmail">,
  gmail: ReturnType<typeof createFakeGmail>,
): SyncDeps {
  return { ...base, gmail: gmail.factory };
}

describe("syncMailbox — backfill", () => {
  it("stores inbox threads, messages and encrypted bodies, then saves the history cursor", async () => {
    const { base, userId, mailAccountId, encryptor } = await connectedGmail();
    await db.insert(userPreferences).values({ userId, bodyCacheDays: 3 });
    const gmail = createFakeGmail({
      historyId: "500",
      threads: {
        t1: [
          fakeMessage({
            providerMessageId: "m1",
            providerThreadId: "t1",
            from: { name: "Ada", address: "ada@x.com" },
            bodyHtml: "<p>Hi</p>",
            bodyText: "Hi",
            labelIds: ["INBOX", "UNREAD"],
          }),
          fakeMessage({
            providerMessageId: "m2",
            providerThreadId: "t1",
            from: { name: "Me", address: "me@gmail.com" },
            sentAt: new Date("2026-11-16T00:00:00Z"),
            labelIds: ["SENT"],
          }),
        ],
      },
    });

    const outcome = await syncMailbox(syncDeps(base, gmail), mailAccountId);

    expect(outcome).toEqual({ status: "synced", mode: "backfill", threads: 1 });
    expect(gmail.calls.listThreadIds[0]?.query).toBe("in:inbox newer_than:30d");
    const [thread] = await db.select().from(threads);
    expect(thread).toMatchObject({ providerThreadId: "t1", messageCount: 2, isUnread: true });
    const rows = await db.select().from(messages).orderBy(messages.sentAt);
    expect(rows.map((m) => [m.providerMessageId, m.isFromUser])).toEqual([
      ["m1", false],
      ["m2", true],
    ]);
    const first = rows[0];
    if (!first?.bodyCiphertext) throw new Error("body not stored");
    expect(first.bodyCiphertext.includes(Buffer.from("<p>Hi</p>"))).toBe(false);
    expect(await decryptBody(encryptor, first.id, first.bodyCiphertext)).toEqual({
      text: "Hi",
      html: "<p>Hi</p>",
    });
    expect(first.bodyExpiresAt?.getTime()).toBe(T0.getTime() + 3 * 86_400_000);
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, mailAccountId));
    expect(account).toMatchObject({ syncCursor: "500", lastError: null, syncLeaseUntil: null });
    expect(account?.lastSyncedAt?.getTime()).toBe(T0.getTime());
  });

  it("stops at the backfill cap", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const seeded: Record<string, ReturnType<typeof fakeMessage>[]> = {};
    for (let i = 0; i < 5; i++) {
      seeded[`t${i}`] = [fakeMessage({ providerMessageId: `m${i}`, providerThreadId: `t${i}` })];
    }
    const gmail = createFakeGmail({ threads: seeded, pageSize: 2 });
    const outcome = await syncMailbox(
      { ...syncDeps(base, gmail), maxBackfillThreads: 3 },
      mailAccountId,
    );
    expect(outcome).toMatchObject({ status: "synced", threads: 3 });
    expect(await db.select().from(threads)).toHaveLength(3);
  });

  it("marks messages carrying the SENT label as from the user (send-as aliases)", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail({
      threads: {
        t1: [
          fakeMessage({
            providerMessageId: "m1",
            providerThreadId: "t1",
            from: { name: null, address: "client@example.com" },
            labelIds: ["INBOX"],
            sentAt: new Date("2026-11-15T00:00:00Z"),
          }),
          fakeMessage({
            providerMessageId: "m2",
            providerThreadId: "t1",
            from: { name: null, address: "alias@company.com" },
            labelIds: ["SENT"],
            sentAt: new Date("2026-11-16T00:00:00Z"),
          }),
        ],
      },
    });

    await syncMailbox(syncDeps(base, gmail), mailAccountId);

    const stored = await db
      .select({ id: messages.providerMessageId, isFromUser: messages.isFromUser })
      .from(messages)
      .orderBy(messages.sentAt);
    expect(stored).toEqual([
      { id: "m1", isFromUser: false },
      { id: "m2", isFromUser: true },
    ]);
  });
});

describe("syncMailbox — incremental", () => {
  it("applies changed threads, deleted messages and vanished threads, then advances the cursor", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail({
      historyId: "100",
      threads: {
        t1: [fakeMessage({ providerMessageId: "m1", providerThreadId: "t1" })],
        t2: [fakeMessage({ providerMessageId: "m2", providerThreadId: "t2" })],
      },
    });
    const deps = syncDeps(base, gmail);
    await syncMailbox(deps, mailAccountId);

    gmail.threads.t1?.push(fakeMessage({ providerMessageId: "m3", providerThreadId: "t1" }));
    delete gmail.threads.t2;
    gmail.history.push({
      changedThreadIds: ["t1", "t2"],
      deletedMessageIds: ["m2"],
      historyId: "180",
      nextPageToken: null,
    });

    expect(await syncMailbox(deps, mailAccountId)).toEqual({
      status: "synced",
      mode: "incremental",
      threads: 1,
    });
    expect(gmail.calls.listHistory[0]?.startHistoryId).toBe("100");
    expect((await db.select().from(threads)).map((t) => t.providerThreadId)).toEqual(["t1"]);
    expect((await db.select().from(messages)).map((m) => m.providerMessageId).sort()).toEqual([
      "m1",
      "m3",
    ]);
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, mailAccountId));
    expect(account?.syncCursor).toBe("180");
  });

  it("falls back to a backfill when the history id has expired", async () => {
    const { base, mailAccountId } = await connectedGmail();
    await db
      .update(mailAccounts)
      .set({ syncCursor: "1" })
      .where(eq(mailAccounts.id, mailAccountId));
    const gmail = createFakeGmail({
      historyId: "900",
      historyExpired: true,
      threads: { t1: [fakeMessage({ providerThreadId: "t1" })] },
    });
    expect(await syncMailbox(syncDeps(base, gmail), mailAccountId)).toMatchObject({
      status: "synced",
      mode: "backfill",
    });
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, mailAccountId));
    expect(account?.syncCursor).toBe("900");
  });
});

describe("syncMailbox — run bounds", () => {
  it("re-backfills when history reports more changed threads than the cap", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail({ historyId: "100", threads: seedThreads(4) });
    const deps = { ...syncDeps(base, gmail), maxBackfillThreads: 3 };
    await syncMailbox(deps, mailAccountId);
    gmail.history.push({
      changedThreadIds: ["t0", "t1", "t2", "t3"],
      deletedMessageIds: [],
      historyId: "200",
      nextPageToken: null,
    });

    expect(await syncMailbox(deps, mailAccountId)).toEqual({
      status: "synced",
      mode: "backfill",
      threads: 3,
    });
    expect(gmail.calls.getThread).toHaveLength(6);
  });

  it("stops at the deadline, keeps committed batches and records a fixed error", async () => {
    const { base, mailAccountId } = await connectedGmail();
    let now = T0;
    const gmail = createFakeGmail({
      threads: seedThreads(5),
      // Every thread fetch takes 5 minutes of (fake) wall time.
      onGetThread: () => {
        now = new Date(now.getTime() + 5 * 60_000);
      },
    });
    const deps = { ...syncDeps(base, gmail), now: () => now, persistBatchSize: 2 };

    await expect(syncMailbox(deps, mailAccountId)).rejects.toBeInstanceOf(SyncDeadlineError);
    // Batch 1 (t0, t1) started before the 8-minute deadline; batch 2 never started a fetch.
    expect(gmail.calls.getThread).toEqual(["t0", "t1"]);
    expect(await storedThreadIds()).toEqual(["t0", "t1"]);
    expect(await accountRow(mailAccountId)).toMatchObject({
      lastError: "Sync is taking longer than expected; will continue on the next sync",
      syncCursor: null,
      syncLeaseUntil: null,
    });
  });

  it("commits batches as it goes and writes the cursor only with the last one", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail({
      historyId: "700",
      threads: seedThreads(5),
      onGetThread: (_id, call) => {
        if (call === 4) throw new ProviderHttpError(500, "/gmail/v1/users/me/threads/t3");
      },
    });
    const deps = { ...syncDeps(base, gmail), persistBatchSize: 2 };

    await expect(syncMailbox(deps, mailAccountId)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(await storedThreadIds()).toEqual(["t0", "t1"]);
    expect(await accountRow(mailAccountId)).toMatchObject({
      syncCursor: null,
      lastError: "Gmail API request failed (500)",
    });

    // The next run completes from scratch and saves the cursor.
    const retry = createFakeGmail({ historyId: "700", threads: seedThreads(5) });
    expect(
      await syncMailbox({ ...syncDeps(base, retry), persistBatchSize: 2 }, mailAccountId),
    ).toMatchObject({ status: "synced", threads: 5 });
    expect(await storedThreadIds()).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect((await accountRow(mailAccountId))?.syncCursor).toBe("700");
  });

  it("asks for a token that stays valid for the whole run", async () => {
    const { base, mailAccountId, provider } = await connectedGmail();
    const gmail = createFakeGmail();
    // Tokens last 60 minutes from T0; 7 minutes remain, inside the default 5-minute skew.
    const later = new Date(T0.getTime() + 53 * 60_000);
    await syncMailbox({ ...syncDeps(base, gmail), now: () => later }, mailAccountId);
    expect(provider.calls.refresh).toBe(1);
  });
});

describe("syncMailbox — drafts and pruning", () => {
  it("does not store drafts; the thread summary comes from the real messages", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const inboundAt = new Date("2026-11-15T00:00:00Z");
    const gmail = createFakeGmail({
      threads: {
        t1: [
          fakeMessage({
            providerMessageId: "in",
            providerThreadId: "t1",
            snippet: "Inbound snippet",
            sentAt: inboundAt,
          }),
          fakeMessage({
            providerMessageId: "draft",
            providerThreadId: "t1",
            from: { name: "Me", address: "me@gmail.com" },
            snippet: "Unsent draft",
            sentAt: new Date("2026-11-16T00:00:00Z"),
            labelIds: ["DRAFT"],
          }),
        ],
        t2: [
          fakeMessage({
            providerMessageId: "only-draft",
            providerThreadId: "t2",
            labelIds: ["DRAFT"],
          }),
        ],
      },
    });
    await syncMailbox(syncDeps(base, gmail), mailAccountId);

    expect((await db.select().from(messages)).map((m) => m.providerMessageId)).toEqual(["in"]);
    const stored = await db.select().from(threads);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      providerThreadId: "t1",
      snippet: "Inbound snippet",
      messageCount: 1,
    });
    expect(stored[0]?.lastMessageAt.getTime()).toBe(inboundAt.getTime());
  });

  it("prunes local threads a re-backfill no longer returns", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const first = createFakeGmail({ historyId: "100", threads: seedThreads(2) });
    await syncMailbox(syncDeps(base, first), mailAccountId);
    expect(await storedThreadIds()).toEqual(["t0", "t1"]);

    const expired = createFakeGmail({
      historyId: "900",
      historyExpired: true,
      threads: { t1: [fakeMessage({ providerMessageId: "m1", providerThreadId: "t1" })] },
    });
    expect(await syncMailbox(syncDeps(base, expired), mailAccountId)).toMatchObject({
      mode: "backfill",
    });
    expect(await storedThreadIds()).toEqual(["t1"]);
  });
});

describe("syncMailbox — guards and failures", () => {
  it("skips mailboxes that are locked, unsupported, needing reauth, or gone", async () => {
    const { base, userId, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail();
    const deps = syncDeps(base, gmail);
    await db
      .update(mailAccounts)
      .set({ syncLeaseUntil: new Date(T0.getTime() + 60_000) })
      .where(eq(mailAccounts.id, mailAccountId));
    expect(await syncMailbox(deps, mailAccountId)).toEqual({ status: "skipped", reason: "locked" });

    const outlook = await insertMailAccount(db, userId, { provider: "outlook" });
    expect(await syncMailbox(deps, outlook.id)).toEqual({
      status: "skipped",
      reason: "unsupported_provider",
    });
    const reauth = await insertMailAccount(db, userId, { status: "needs_reauth" });
    expect(await syncMailbox(deps, reauth.id)).toEqual({
      status: "skipped",
      reason: "needs_reauth",
    });
    expect(await syncMailbox(deps, "00000000-0000-4000-8000-000000000000")).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    expect(gmail.calls.factory).toBe(0);
  });

  it("records a non-secret error, keeps the old cursor, releases the lease and rethrows", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail({
      failWith: new ProviderHttpError(500, "/gmail/v1/users/me/threads"),
    });
    const deps = syncDeps(base, gmail);
    await expect(syncMailbox(deps, mailAccountId)).rejects.toBeInstanceOf(ProviderHttpError);
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, mailAccountId));
    expect(account).toMatchObject({
      lastError: "Gmail API request failed (500)",
      syncCursor: null,
      syncLeaseUntil: null,
      status: "active",
    });
    expect(await db.select().from(threads)).toHaveLength(0);
  });

  it("uses the message body AAD so a body cannot be decrypted as another message", async () => {
    const { base, mailAccountId, encryptor } = await connectedGmail();
    const gmail = createFakeGmail({
      threads: {
        t1: [
          fakeMessage({ providerMessageId: "a", providerThreadId: "t1", bodyText: "secret" }),
          fakeMessage({ providerMessageId: "b", providerThreadId: "t1", bodyText: "other" }),
        ],
      },
    });
    await syncMailbox(syncDeps(base, gmail), mailAccountId);
    const [a, b] = await db.select().from(messages).orderBy(messages.providerMessageId);
    if (!a?.bodyCiphertext || !b) throw new Error("missing rows");
    await expect(encryptor.decrypt(a.bodyCiphertext, aad.messageBody(b.id))).rejects.toThrow();
  });
});
