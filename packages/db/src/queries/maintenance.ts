import { and, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../client";
import { messages } from "../schema/mail";

/** Drops cached bodies past their TTL. Returns the number of messages purged. */
export async function purgeExpiredBodies(db: Db, now: Date = new Date()): Promise<number> {
  const purged = await db
    .update(messages)
    .set({ bodyCiphertext: null, bodyExpiresAt: null })
    .where(and(isNotNull(messages.bodyExpiresAt), lte(messages.bodyExpiresAt, now)))
    .returning({ id: messages.id });
  return purged.length;
}
