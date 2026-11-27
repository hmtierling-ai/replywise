import { type Db, mailAccounts, messages, threads } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import {
  completeConnect,
  MailAccountNotFoundError,
  ReauthRequiredError,
  startConnect,
} from "@replywise/mailbox";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SyncDeps } from "./deps";
import { importThread, searchGmailThreads } from "./gmail-search";
import { syncMailbox } from "./sync-mailbox";
import { createFakeGmail, fakeMessage } from "./testing";

const T0 = new Date("2026-11-25T12:00:00Z");
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function connected() {
  const provider = createFakeProvider("gmail", { email: "me@gmail.com" });
  const encryptor = testEncryptor();
  const user = await insertUser(db);
  const base = { db, encryptor, providers: { gmail: provider.provider }, now: () => T0 };
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
  const gmail = createFakeGmail({
    threads: {
      t1: [
        fakeMessage({
          providerMessageId: "m1",
          providerThreadId: "t1",
          subject: "Invoice March",
          snippet: "March invoice",
          from: { name: "Billing", address: "billing@vendor.example" },
        }),
      ],
    },
  });
  const deps: SyncDeps = { ...base, gmail: gmail.factory };
  await syncMailbox(deps, mailAccountId);
  // Older mail outside the backfill: only Gmail search finds it.
  gmail.threads.old = [
    fakeMessage({
      providerMessageId: "o1",
      providerThreadId: "old",
      subject: "Invoice 2024",
      snippet: "Old invoice",
      bodyText: "Total: 120 EUR",
      sentAt: new Date("2024-03-01T00:00:00Z"),
    }),
  ];
  return { deps, gmail, userId: user.id, mailAccountId };
}

describe("searchGmailThreads", () => {
  it("returns metadata for Gmail matches and marks threads that are already synced", async () => {
    const { deps, gmail, userId, mailAccountId } = await connected();
    const [synced] = await db.select().from(threads).where(eq(threads.providerThreadId, "t1"));
    const results = await searchGmailThreads(deps, { userId, mailAccountId, query: " invoice " });
    expect(gmail.calls.listThreadIds.at(-1)).toEqual({ query: "invoice", maxResults: 20 });
    expect(results).toEqual([
      {
        providerThreadId: "t1",
        subject: "Invoice March",
        from: { name: "Billing", address: "billing@vendor.example" },
        date: expect.any(Date),
        snippet: "March invoice",
        localThreadId: synced?.id,
      },
      {
        providerThreadId: "old",
        subject: "Invoice 2024",
        from: expect.any(Object),
        date: new Date("2024-03-01T00:00:00Z"),
        snippet: "Old invoice",
        localThreadId: null,
      },
    ]);
  });

  it("refuses another user's mailbox before calling Gmail", async () => {
    const { deps, gmail, mailAccountId } = await connected();
    const mallory = await insertUser(db);
    const before = gmail.calls.factory;
    await expect(
      searchGmailThreads(deps, { userId: mallory.id, mailAccountId, query: "x" }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
    await expect(
      importThread(deps, { userId: mallory.id, mailAccountId, providerThreadId: "old" }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
    expect(gmail.calls.factory).toBe(before);
  });

  it("asks for reconnection when the mailbox needs it", async () => {
    const { deps, userId, mailAccountId } = await connected();
    await db
      .update(mailAccounts)
      .set({ status: "needs_reauth" })
      .where(eq(mailAccounts.id, mailAccountId));
    await expect(
      searchGmailThreads(deps, { userId, mailAccountId, query: "x" }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
  });
});

describe("importThread", () => {
  it("stores a Gmail thread like sync does and returns its local id, idempotently", async () => {
    const { deps, userId, mailAccountId } = await connected();
    const id = await importThread(deps, { userId, mailAccountId, providerThreadId: "old" });
    expect(id).toEqual(expect.any(String));
    const [row] = await db.select().from(threads).where(eq(threads.providerThreadId, "old"));
    expect(row).toMatchObject({ id, subject: "Invoice 2024" });
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, id ?? ""));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.bodyCiphertext).not.toBeNull();
    expect(await importThread(deps, { userId, mailAccountId, providerThreadId: "old" })).toBe(id);
  });

  it("returns null when Gmail no longer has the thread", async () => {
    const { deps, userId, mailAccountId } = await connected();
    expect(
      await importThread(deps, { userId, mailAccountId, providerThreadId: "nope" }),
    ).toBeNull();
  });
});
