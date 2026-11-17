import { type Db, messages } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { completeConnect, startConnect } from "@replywise/mailbox";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SyncDeps } from "./deps";
import { syncMailbox } from "./sync-mailbox";
import { createFakeGmail, fakeMessage } from "./testing";
import { loadThreadForUser } from "./thread-view";

const T0 = new Date("2026-11-17T12:00:00Z");
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function syncedMailbox() {
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
          bodyHtml: "<p>one</p>",
          bodyText: "one",
        }),
        fakeMessage({
          providerMessageId: "m2",
          providerThreadId: "t1",
          bodyText: "two",
          sentAt: new Date("2026-11-16T00:00:00Z"),
        }),
      ],
    },
  });
  const deps: SyncDeps = { ...base, gmail: gmail.factory };
  await syncMailbox(deps, mailAccountId);
  const [row] = await db.select({ threadId: messages.threadId }).from(messages).limit(1);
  if (!row) throw new Error("sync stored nothing");
  return { deps, gmail, userId: user.id, threadId: row.threadId };
}

describe("loadThreadForUser", () => {
  it("returns decrypted bodies oldest first without calling Gmail", async () => {
    const { deps, gmail, userId, threadId } = await syncedMailbox();
    const factoryCalls = gmail.calls.factory;
    const view = await loadThreadForUser(deps, userId, threadId);
    expect(view?.messages.map((m) => m.body)).toEqual([
      { text: "one", html: "<p>one</p>" },
      { text: "two", html: null },
    ]);
    expect(view?.bodiesUnavailable).toBe(false);
    expect(view?.mailbox).toEqual({ provider: "gmail", emailAddress: "me@gmail.com" });
    expect(gmail.calls.factory).toBe(factoryCalls);
  });

  it("refetches expired bodies from Gmail and caches them again", async () => {
    const { deps, gmail, userId, threadId } = await syncedMailbox();
    await db.update(messages).set({ bodyCiphertext: null, bodyExpiresAt: null });
    const view = await loadThreadForUser(deps, userId, threadId);
    expect(view?.messages[0]?.body?.text).toBe("one");
    expect(gmail.calls.getThread.at(-1)).toBe("t1");
    const rows = await db.select().from(messages);
    expect(rows.every((m) => m.bodyCiphertext !== null)).toBe(true);
  });

  it("returns null for another user's thread", async () => {
    const { deps, threadId } = await syncedMailbox();
    const mallory = await insertUser(db);
    expect(await loadThreadForUser(deps, mallory.id, threadId)).toBeNull();
  });

  it("marks bodies unavailable instead of failing when Gmail cannot be reached", async () => {
    const { deps, userId, threadId } = await syncedMailbox();
    await db.update(messages).set({ bodyCiphertext: null, bodyExpiresAt: null });
    const failing: SyncDeps = {
      ...deps,
      gmail: () => {
        throw new Error("offline");
      },
    };
    const view = await loadThreadForUser(failing, userId, threadId);
    expect(view?.bodiesUnavailable).toBe(true);
    expect(view?.messages.every((m) => m.body === null)).toBe(true);
  });
});
