import { auditLogs, type Db, mailAccounts } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getValidAccessToken } from "./access-token";
import { completeConnect, startConnect } from "./connect";
import type { MailboxDeps } from "./deps";
import { ReauthRequiredError } from "./errors";
import { createFakeProvider, type FakeProviderOptions, testEncryptor } from "./testing";

const T0 = new Date("2026-11-16T12:00:00Z");
const MIN = 60_000;

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

/** Connects a mailbox at T0 with 60-minute tokens; returns deps factory bound to a clock. */
async function connected(options: FakeProviderOptions = {}) {
  const fake = createFakeProvider("gmail", options);
  const encryptor = testEncryptor();
  const at = (now: Date): MailboxDeps => ({
    db,
    encryptor,
    providers: { gmail: fake.provider },
    now: () => now,
  });
  const user = await insertUser(db);
  const url = await startConnect(at(T0), {
    userId: user.id,
    provider: "gmail",
    redirectUri: "http://cb",
  });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(at(T0), {
    userId: user.id,
    provider: "gmail",
    code: "c",
    state,
    redirectUri: "http://cb",
  });
  return { fake, at, mailAccountId, userId: user.id };
}

describe("getValidAccessToken", () => {
  it("returns the stored token while it is fresh", async () => {
    const { fake, at, mailAccountId } = await connected();
    const result = await getValidAccessToken(at(new Date(T0.getTime() + 30 * MIN)), mailAccountId);
    expect(result).toEqual({ accessToken: "access-1", provider: "gmail" });
    expect(fake.calls.refresh).toBe(0);
  });

  it("refreshes within 5 minutes of expiry and stores the new tokens", async () => {
    const { fake, at, mailAccountId } = await connected();
    const nearExpiry = at(new Date(T0.getTime() + 56 * MIN));
    expect((await getValidAccessToken(nearExpiry, mailAccountId)).accessToken).toBe("access-2");
    expect((await getValidAccessToken(nearExpiry, mailAccountId)).accessToken).toBe("access-2");
    expect(fake.calls.refresh).toBe(1);
  });

  it("serializes concurrent refreshes with a row lock", async () => {
    const { fake, at, mailAccountId } = await connected({ refreshDelayMs: 150 });
    const nearExpiry = at(new Date(T0.getTime() + 58 * MIN));
    const [a, b] = await Promise.all([
      getValidAccessToken(nearExpiry, mailAccountId),
      getValidAccessToken(nearExpiry, mailAccountId),
    ]);
    expect(fake.calls.refresh).toBe(1);
    expect(a.accessToken).toBe("access-2");
    expect(b.accessToken).toBe("access-2");
  });

  it("marks the mailbox as needing reauth when the refresh token is revoked", async () => {
    const { fake, at, mailAccountId, userId } = await connected({ refreshError: "invalid_grant" });
    const later = at(new Date(T0.getTime() + 2 * 60 * MIN));
    await expect(getValidAccessToken(later, mailAccountId)).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );

    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, mailAccountId));
    expect(account?.status).toBe("needs_reauth");
    expect(account?.lastError).toMatch(/reconnect/i);
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.userId, userId))).map(
      (a) => a.action,
    );
    expect(actions).toContain("mailbox.reauth_required");

    await expect(getValidAccessToken(later, mailAccountId)).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
    expect(fake.calls.refresh).toBe(1);
  });
});
