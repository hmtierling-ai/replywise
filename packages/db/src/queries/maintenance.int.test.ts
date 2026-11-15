import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { messages } from "../schema/mail";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import { purgeExpiredBodies } from "./maintenance";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("purgeExpiredBodies", () => {
  it("clears only bodies whose TTL has passed", async () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    const expired = await insertMessage(db, thread.id, account.id, {
      bodyCiphertext: Buffer.from("old"),
      bodyExpiresAt: new Date("2026-11-15T11:59:59Z"),
    });
    const fresh = await insertMessage(db, thread.id, account.id, {
      bodyCiphertext: Buffer.from("new"),
      bodyExpiresAt: new Date("2026-11-16T00:00:00Z"),
    });

    expect(await purgeExpiredBodies(db, now)).toBe(1);

    const [expiredRow] = await db.select().from(messages).where(eq(messages.id, expired.id));
    const [freshRow] = await db.select().from(messages).where(eq(messages.id, fresh.id));
    expect(expiredRow?.bodyCiphertext).toBeNull();
    expect(expiredRow?.bodyExpiresAt).toBeNull();
    expect(freshRow?.bodyCiphertext?.toString()).toBe("new");
  });

  it("returns 0 when nothing is expired", async () => {
    expect(await purgeExpiredBodies(db)).toBe(0);
  });
});
