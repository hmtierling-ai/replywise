import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { auditLogs, mailOAuthStates } from "../schema/index";
import { insertMailAccount, insertThread, insertUser, resetTestDb, setupTestDb } from "../testing";
import { insertAuditLog } from "./audit";
import {
  consumeOAuthState,
  deleteMailAccountForUser,
  getMailAccountForUser,
  insertOAuthState,
  listMailAccounts,
  purgeExpiredOAuthStates,
} from "./mailboxes";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("mailbox queries are scoped to their owner", () => {
  it("lists only the user's mailboxes and never returns token ciphertext", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    await insertMailAccount(db, alice.id, { emailAddress: "alice@gmail.com" });
    await insertMailAccount(db, bob.id, { emailAddress: "bob@gmail.com" });

    const list = await listMailAccounts(db, alice.id);
    expect(list.map((a) => a.emailAddress)).toEqual(["alice@gmail.com"]);
    expect(list[0]).not.toHaveProperty("tokensCiphertext");
  });

  it("does not let one user read or delete another user's mailbox", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const account = await insertMailAccount(db, alice.id);
    await insertThread(db, account.id);

    expect(await getMailAccountForUser(db, bob.id, account.id)).toBeNull();
    expect(await deleteMailAccountForUser(db, bob.id, account.id)).toBe(false);
    expect(await getMailAccountForUser(db, alice.id, account.id)).not.toBeNull();

    expect(await deleteMailAccountForUser(db, alice.id, account.id)).toBe(true);
    expect(await getMailAccountForUser(db, alice.id, account.id)).toBeNull();
  });
});

describe("OAuth states", () => {
  it("can be consumed exactly once", async () => {
    const user = await insertUser(db);
    await insertOAuthState(db, {
      stateHash: "h1",
      userId: user.id,
      provider: "gmail",
      codeVerifierCiphertext: Buffer.from("v"),
      returnTo: "/settings/mailboxes",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await consumeOAuthState(db, "h1"))?.userId).toBe(user.id);
    expect(await consumeOAuthState(db, "h1")).toBeNull();
    expect(await consumeOAuthState(db, "never-issued")).toBeNull();
  });

  it("purges only expired states", async () => {
    const user = await insertUser(db);
    const now = new Date("2026-11-16T12:00:00Z");
    for (const [hash, expiresAt] of [
      ["old", new Date("2026-11-16T11:59:00Z")],
      ["fresh", new Date("2026-11-16T12:05:00Z")],
    ] as const) {
      await insertOAuthState(db, {
        stateHash: hash,
        userId: user.id,
        provider: "outlook",
        codeVerifierCiphertext: Buffer.from("v"),
        returnTo: "/settings/mailboxes",
        expiresAt,
      });
    }
    expect(await purgeExpiredOAuthStates(db, now)).toBe(1);
    expect((await db.select().from(mailOAuthStates)).map((s) => s.stateHash)).toEqual(["fresh"]);
  });
});

describe("insertAuditLog", () => {
  it("records the action with context", async () => {
    const user = await insertUser(db);
    await insertAuditLog(db, {
      userId: user.id,
      action: "mailbox.connected",
      targetType: "mail_account",
      targetId: "acc-1",
      ip: "203.0.113.7",
      userAgent: "test-agent",
      metadata: { provider: "gmail" },
    });
    const [row] = await db.select().from(auditLogs);
    expect(row).toMatchObject({
      action: "mailbox.connected",
      targetId: "acc-1",
      ip: "203.0.113.7",
      metadata: { provider: "gmail" },
    });
  });
});
