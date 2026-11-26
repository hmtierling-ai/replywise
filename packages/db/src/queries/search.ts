import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { threadInsights } from "../schema/ai";
import { mailAccounts, threads } from "../schema/mail";
import { type InboxThread, otherThreadSql, threadListColumns } from "./threads";

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 200;

export type ThreadLocation = "inbox" | "other" | "sent" | "archived";

export interface SearchThread extends InboxThread {
  location: ThreadLocation;
}

/** Escapes LIKE metacharacters so user input matches literally (backslash is the default escape). */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

/**
 * Case-insensitive search over subject, snippet and participants of every synced thread the
 * user owns (inbox, sent, other, imported). Bodies are not searched (spec M6 §5.1).
 */
export async function searchThreads(
  db: DbExecutor,
  userId: string,
  query: string,
  limit = 50,
): Promise<SearchThread[]> {
  const q = query.trim().slice(0, SEARCH_MAX_CHARS);
  if (q.length < SEARCH_MIN_CHARS) return [];
  const pattern = `%${escapeLikePattern(q)}%`;
  const rows = await db
    .select({
      ...threadListColumns,
      inInbox: sql<boolean>`${threads.providerLabels} @> array['INBOX']::text[]`,
      inSent: sql<boolean>`${threads.providerLabels} @> array['SENT']::text[]`,
      other: sql<boolean>`${otherThreadSql(threads.id, threads.providerLabels)}`,
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .leftJoin(threadInsights, eq(threadInsights.threadId, threads.id))
    .where(
      and(
        eq(mailAccounts.userId, userId),
        or(
          ilike(threads.subject, pattern),
          ilike(threads.snippet, pattern),
          ilike(threads.participantsText, pattern),
        ),
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
  return rows.map(({ inInbox, inSent, other, ...thread }) => ({
    ...thread,
    location: inInbox ? (other ? "other" : "inbox") : inSent ? "sent" : "archived",
  }));
}
