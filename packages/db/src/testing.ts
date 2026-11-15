import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./client";
import { runMigrations } from "./migrate";
import { users } from "./schema/auth";
import { mailAccounts, messages, threads } from "./schema/mail";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgres://replywise:replywise@localhost:5432/replywise_test";

export async function setupTestDb() {
  await runMigrations(TEST_DATABASE_URL);
  return createDb(TEST_DATABASE_URL, { max: 2 });
}

/** Truncating users cascades to every user-owned table. */
export async function resetTestDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table users, audit_logs cascade`);
}

export async function insertUser(db: Db, overrides: Partial<typeof users.$inferInsert> = {}) {
  const id = overrides.id ?? randomUUID();
  const [row] = await db
    .insert(users)
    .values({ id, name: "Test User", email: `${id}@example.com`, ...overrides })
    .returning();
  if (!row) throw new Error("insertUser failed");
  return row;
}

export async function insertMailAccount(
  db: Db,
  userId: string,
  overrides: Partial<typeof mailAccounts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(mailAccounts)
    .values({
      userId,
      provider: "gmail",
      emailAddress: `${randomUUID()}@gmail.com`,
      tokensCiphertext: Buffer.from("not-really-encrypted"),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertMailAccount failed");
  return row;
}

export async function insertThread(
  db: Db,
  mailAccountId: string,
  overrides: Partial<typeof threads.$inferInsert> = {},
) {
  const [row] = await db
    .insert(threads)
    .values({
      mailAccountId,
      providerThreadId: randomUUID(),
      lastMessageAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertThread failed");
  return row;
}

export async function insertMessage(
  db: Db,
  threadId: string,
  mailAccountId: string,
  overrides: Partial<typeof messages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(messages)
    .values({
      threadId,
      mailAccountId,
      providerMessageId: randomUUID(),
      fromAddress: { name: "Sender", address: "sender@example.com" },
      sentAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertMessage failed");
  return row;
}

/** Postgres error code from a driver error, whether or not the ORM wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current =
      typeof current === "object" && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}
