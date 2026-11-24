import { and, eq, lte } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { mailAccounts, mailOAuthStates } from "../schema/mail";

export type MailAccount = typeof mailAccounts.$inferSelect;

const summaryColumns = {
  id: mailAccounts.id,
  provider: mailAccounts.provider,
  emailAddress: mailAccounts.emailAddress,
  displayName: mailAccounts.displayName,
  status: mailAccounts.status,
  lastSyncedAt: mailAccounts.lastSyncedAt,
  lastError: mailAccounts.lastError,
  createdAt: mailAccounts.createdAt,
  autoDraftNeedsReply: mailAccounts.autoDraftNeedsReply,
};

export type MailAccountSummary = {
  [K in keyof typeof summaryColumns]: MailAccount[K];
};

/** Safe for the UI: never includes token ciphertext. */
export async function listMailAccounts(
  db: DbExecutor,
  userId: string,
): Promise<MailAccountSummary[]> {
  return db
    .select(summaryColumns)
    .from(mailAccounts)
    .where(eq(mailAccounts.userId, userId))
    .orderBy(mailAccounts.createdAt);
}

export async function getMailAccountForUser(
  db: DbExecutor,
  userId: string,
  id: string,
): Promise<MailAccount | null> {
  const [row] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)));
  return row ?? null;
}

export async function deleteMailAccountForUser(
  db: DbExecutor,
  userId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)))
    .returning({ id: mailAccounts.id });
  return deleted.length > 0;
}

export async function insertOAuthState(
  db: DbExecutor,
  values: typeof mailOAuthStates.$inferInsert,
): Promise<void> {
  await db.insert(mailOAuthStates).values(values);
}

/** Deletes and returns the state row: a state can only ever be used once. */
export async function consumeOAuthState(
  db: DbExecutor,
  stateHash: string,
): Promise<typeof mailOAuthStates.$inferSelect | null> {
  const [row] = await db
    .delete(mailOAuthStates)
    .where(eq(mailOAuthStates.stateHash, stateHash))
    .returning();
  return row ?? null;
}

export async function purgeExpiredOAuthStates(
  db: DbExecutor,
  now: Date = new Date(),
): Promise<number> {
  const purged = await db
    .delete(mailOAuthStates)
    .where(lte(mailOAuthStates.expiresAt, now))
    .returning({ stateHash: mailOAuthStates.stateHash });
  return purged.length;
}
