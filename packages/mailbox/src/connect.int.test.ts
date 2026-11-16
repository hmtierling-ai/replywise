import { aad } from "@replywise/crypto";
import { auditLogs, type Db, mailAccounts, mailOAuthStates } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { codeChallengeS256 } from "@replywise/mail";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { completeConnect, MAILBOXES_PATH, startConnect } from "./connect";
import type { MailboxDeps } from "./deps";
import { ConnectError } from "./errors";
import { createFakeProvider, testEncryptor } from "./testing";
import { decryptTokens } from "./tokens-codec";

const REDIRECT = "http://localhost:3000/api/oauth/gmail/callback";
const T0 = new Date("2026-11-16T12:00:00Z");

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

function deps(fake = createFakeProvider("gmail"), now = T0): MailboxDeps {
  return { db, encryptor: testEncryptor(), providers: { gmail: fake.provider }, now: () => now };
}

async function begin(d: MailboxDeps, userId: string) {
  const url = await startConnect(d, { userId, provider: "gmail", redirectUri: REDIRECT });
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("no state in authorization URL");
  return state;
}

const reason = (r: ConnectError["reason"]) => (e: unknown) =>
  e instanceof ConnectError && e.reason === r;

describe("startConnect", () => {
  it("stores only a hash of the state and an encrypted PKCE verifier", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail");
    const d = deps(fake);
    const state = await begin(d, user.id);

    const [row] = await db.select().from(mailOAuthStates);
    expect(row?.stateHash).not.toBe(state);
    expect(row?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.returnTo).toBe(MAILBOXES_PATH);
    expect(row?.expiresAt.getTime()).toBe(T0.getTime() + 10 * 60_000);
    if (!row) throw new Error("no state row");
    const verifier = await d.encryptor.decryptString(
      row.codeVerifierCiphertext,
      aad.oauthVerifier(row.stateHash),
    );
    expect(codeChallengeS256(verifier)).toBe(fake.calls.lastAuthorization?.codeChallenge);
    expect(row.codeVerifierCiphertext.includes(Buffer.from(verifier))).toBe(false);
  });

  it("refuses providers that are not configured", async () => {
    const user = await insertUser(db);
    const d: MailboxDeps = { ...deps(), providers: {} };
    await expect(
      startConnect(d, { userId: user.id, provider: "gmail", redirectUri: REDIRECT }),
    ).rejects.toSatisfy(reason("not_configured"));
  });
});

describe("completeConnect", () => {
  it("connects a mailbox with encrypted tokens, PKCE verified, and audits it", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail", { email: "me@gmail.com" });
    const d = deps(fake);
    const state = await begin(d, user.id);

    const result = await completeConnect(d, {
      userId: user.id,
      provider: "gmail",
      code: "good-code",
      state,
      redirectUri: REDIRECT,
      context: { ip: "203.0.113.9", userAgent: "vitest" },
    });

    expect(result).toMatchObject({ emailAddress: "me@gmail.com", reconnected: false });
    expect(codeChallengeS256(fake.calls.lastCodeVerifier)).toBe(
      fake.calls.lastAuthorization?.codeChallenge,
    );
    const [account] = await db.select().from(mailAccounts);
    if (!account) throw new Error("no account");
    expect(account.id).toBe(result.mailAccountId);
    expect(account.status).toBe("active");
    expect(account.grantedScopes).toEqual(["scope.read", "scope.compose"]);
    expect(account.tokensCiphertext.includes(Buffer.from("access-1"))).toBe(false);
    const tokens = await decryptTokens(d.encryptor, result.mailAccountId, account.tokensCiphertext);
    expect(tokens.accessToken).toBe("access-1");

    const [audit] = await db.select().from(auditLogs);
    expect(audit).toMatchObject({
      action: "mailbox.connected",
      targetId: result.mailAccountId,
      ip: "203.0.113.9",
      metadata: { provider: "gmail" },
    });
    expect(await db.select().from(mailOAuthStates)).toHaveLength(0);
  });

  it("rejects a state that was already used", async () => {
    const user = await insertUser(db);
    const d = deps();
    const state = await begin(d, user.id);
    const input = {
      userId: user.id,
      provider: "gmail" as const,
      code: "c",
      state,
      redirectUri: REDIRECT,
    };
    await completeConnect(d, input);
    await expect(completeConnect(d, input)).rejects.toSatisfy(reason("invalid_state"));
  });

  it("rejects a state issued to a different user", async () => {
    const alice = await insertUser(db);
    const mallory = await insertUser(db);
    const d = deps();
    const state = await begin(d, alice.id);
    await expect(
      completeConnect(d, {
        userId: mallory.id,
        provider: "gmail",
        code: "c",
        state,
        redirectUri: REDIRECT,
      }),
    ).rejects.toSatisfy(reason("invalid_state"));
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("rejects an expired state", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail");
    const state = await begin(deps(fake, T0), user.id);
    const later = deps(fake, new Date(T0.getTime() + 11 * 60_000));
    await expect(
      completeConnect(later, {
        userId: user.id,
        provider: "gmail",
        code: "c",
        state,
        redirectUri: REDIRECT,
      }),
    ).rejects.toSatisfy(reason("expired_state"));
  });

  it("rejects a state replayed against another provider", async () => {
    const user = await insertUser(db);
    const gmail = createFakeProvider("gmail");
    const outlook = createFakeProvider("outlook");
    const d: MailboxDeps = {
      ...deps(gmail),
      providers: { gmail: gmail.provider, outlook: outlook.provider },
    };
    const state = await begin(d, user.id);
    await expect(
      completeConnect(d, {
        userId: user.id,
        provider: "outlook",
        code: "c",
        state,
        redirectUri: REDIRECT,
      }),
    ).rejects.toSatisfy(reason("provider_mismatch"));
  });

  it("refuses the connection when required scopes were not granted", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail", { grantedScopes: ["scope.read"] });
    const d = deps(fake);
    const state = await begin(d, user.id);
    await expect(
      completeConnect(d, {
        userId: user.id,
        provider: "gmail",
        code: "c",
        state,
        redirectUri: REDIRECT,
      }),
    ).rejects.toSatisfy(reason("missing_scopes"));
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
    expect(fake.calls.revoke).toBe(1);
  });

  it("maps a failed code exchange to provider_error", async () => {
    const user = await insertUser(db);
    const d = deps();
    const state = await begin(d, user.id);
    await expect(
      completeConnect(d, {
        userId: user.id,
        provider: "gmail",
        code: "bad-code",
        state,
        redirectUri: REDIRECT,
      }),
    ).rejects.toSatisfy(reason("provider_error"));
  });

  it("reconnecting the same mailbox keeps its id and restores active status", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail", { email: "me@gmail.com" });
    const d = deps(fake);
    const first = await completeConnect(d, {
      userId: user.id,
      provider: "gmail",
      code: "c",
      state: await begin(d, user.id),
      redirectUri: REDIRECT,
    });
    await db
      .update(mailAccounts)
      .set({ status: "needs_reauth", lastError: "revoked" })
      .where(eq(mailAccounts.id, first.mailAccountId));

    const second = await completeConnect(d, {
      userId: user.id,
      provider: "gmail",
      code: "c",
      state: await begin(d, user.id),
      redirectUri: REDIRECT,
    });
    expect(second).toMatchObject({ mailAccountId: first.mailAccountId, reconnected: true });
    const [account] = await db.select().from(mailAccounts);
    if (!account) throw new Error("no account");
    expect(account).toMatchObject({ status: "active", lastError: null });
    const tokens = await decryptTokens(d.encryptor, first.mailAccountId, account.tokensCiphertext);
    expect(tokens.accessToken).toBe("access-2");
    const actions = (await db.select().from(auditLogs)).map((a) => a.action).sort();
    expect(actions).toEqual(["mailbox.connected", "mailbox.reconnected"]);
  });
});
