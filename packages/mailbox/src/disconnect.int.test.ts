import { auditLogs, type Db, mailAccounts, threads } from "@replywise/db";
import { insertThread, insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { completeConnect, startConnect } from "./connect";
import type { MailboxDeps } from "./deps";
import { disconnectMailbox } from "./disconnect";
import { MailAccountNotFoundError } from "./errors";
import { createFakeProvider, testEncryptor } from "./testing";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function connect(provider: "gmail" | "outlook", supportsRevocation: boolean) {
  const fake = createFakeProvider(provider, { supportsRevocation });
  const d: MailboxDeps = {
    db,
    encryptor: testEncryptor(),
    providers: { [provider]: fake.provider },
  };
  const user = await insertUser(db);
  const url = await startConnect(d, { userId: user.id, provider, redirectUri: "http://cb" });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(d, {
    userId: user.id,
    provider,
    code: "c",
    state,
    redirectUri: "http://cb",
  });
  return { fake, d, userId: user.id, mailAccountId };
}

describe("disconnectMailbox", () => {
  it("revokes at the provider, deletes the mailbox with its data, and audits", async () => {
    const { fake, d, userId, mailAccountId } = await connect("gmail", true);
    await insertThread(db, mailAccountId);

    const result = await disconnectMailbox(d, {
      userId,
      mailAccountId,
      context: { ip: "198.51.100.4" },
    });

    expect(result).toEqual({ provider: "gmail", revoked: true });
    expect(fake.calls.revoke).toBe(1);
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
    expect(await db.select().from(threads)).toHaveLength(0);
    const actions = (await db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toContain("mailbox.disconnected");
  });

  it("reports revoked=false for providers without a revocation API", async () => {
    const { d, userId, mailAccountId } = await connect("outlook", false);
    expect(await disconnectMailbox(d, { userId, mailAccountId })).toEqual({
      provider: "outlook",
      revoked: false,
    });
  });

  it("still disconnects when revocation fails", async () => {
    const { fake, d, userId, mailAccountId } = await connect("gmail", true);
    fake.provider.revoke = async () => {
      throw new Error("network down");
    };
    expect(await disconnectMailbox(d, { userId, mailAccountId })).toEqual({
      provider: "gmail",
      revoked: false,
    });
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("refuses to disconnect another user's mailbox", async () => {
    const { d, mailAccountId } = await connect("gmail", true);
    const mallory = await insertUser(db);
    await expect(
      disconnectMailbox(d, { userId: mallory.id, mailAccountId }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
    expect(await db.select().from(mailAccounts)).toHaveLength(1);
  });
});
