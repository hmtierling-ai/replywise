import {
  acquireSyncLease,
  deleteMessagesByProviderIds,
  deleteThreadsByProviderIds,
  mailAccounts,
  recordSyncFailure,
  recordSyncSuccess,
  releaseSyncLease,
} from "@replywise/db";
import { type GmailApi, HistoryExpiredError, type ParsedThread } from "@replywise/mail";
import { clock, getValidAccessToken, ReauthRequiredError } from "@replywise/mailbox";
import { eq } from "drizzle-orm";
import { mapWithConcurrency } from "./concurrency";
import type { SyncDeps } from "./deps";
import { describeSyncError } from "./errors";
import { persistThreads } from "./persist";

export const SYNC_LEASE_MS = 10 * 60 * 1000;
export const BACKFILL_QUERY = "in:inbox newer_than:30d";
export const MAX_BACKFILL_THREADS = 300;
const PAGE_SIZE = 100;
const FETCH_CONCURRENCY = 5;

export type SyncOutcome =
  | { status: "synced"; mode: "backfill" | "incremental"; threads: number }
  | { status: "skipped"; reason: "not_found" | "unsupported_provider" | "needs_reauth" | "locked" };

interface Changes {
  mode: "backfill" | "incremental";
  threads: ParsedThread[];
  vanishedThreadIds: string[];
  deletedMessageIds: string[];
  cursor: string;
}

async function backfill(api: GmailApi, cap: number): Promise<Changes> {
  // Take the history id first so changes made during the backfill are replayed next time.
  const { historyId } = await api.getProfile();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api.listThreadIds({
      query: BACKFILL_QUERY,
      maxResults: Math.min(PAGE_SIZE, cap - ids.length),
      ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...page.ids.slice(0, cap - ids.length));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && ids.length < cap);
  const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, (id) => api.getThread(id));
  return {
    mode: "backfill",
    threads: fetched.filter((t): t is ParsedThread => t !== null),
    vanishedThreadIds: [],
    deletedMessageIds: [],
    cursor: historyId,
  };
}

async function incremental(api: GmailApi, startHistoryId: string): Promise<Changes> {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let cursor = startHistoryId;
  let pageToken: string | undefined;
  do {
    const page = await api.listHistory({ startHistoryId, ...(pageToken ? { pageToken } : {}) });
    for (const id of page.changedThreadIds) changed.add(id);
    for (const id of page.deletedMessageIds) deleted.add(id);
    cursor = page.historyId;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  const ids = [...changed];
  const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, (id) => api.getThread(id));
  return {
    mode: "incremental",
    threads: fetched.filter((t): t is ParsedThread => t !== null),
    vanishedThreadIds: ids.filter((_, i) => fetched[i] === null),
    deletedMessageIds: [...deleted],
    cursor,
  };
}

/** Syncs one Gmail mailbox. Safe to call concurrently: a DB lease admits one run at a time. */
export async function syncMailbox(deps: SyncDeps, mailAccountId: string): Promise<SyncOutcome> {
  const now = clock(deps);
  const [account] = await deps.db
    .select({
      id: mailAccounts.id,
      userId: mailAccounts.userId,
      provider: mailAccounts.provider,
      emailAddress: mailAccounts.emailAddress,
      status: mailAccounts.status,
      syncCursor: mailAccounts.syncCursor,
    })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, mailAccountId));
  if (!account) return { status: "skipped", reason: "not_found" };
  if (account.provider !== "gmail") return { status: "skipped", reason: "unsupported_provider" };
  if (account.status === "needs_reauth") return { status: "skipped", reason: "needs_reauth" };
  if (!(await acquireSyncLease(deps.db, account.id, now, SYNC_LEASE_MS))) {
    return { status: "skipped", reason: "locked" };
  }

  try {
    let accessToken: string;
    try {
      ({ accessToken } = await getValidAccessToken(deps, account.id));
    } catch (error) {
      if (error instanceof ReauthRequiredError)
        return { status: "skipped", reason: "needs_reauth" };
      throw error;
    }
    const api = deps.gmail(accessToken);
    const cap = deps.maxBackfillThreads ?? MAX_BACKFILL_THREADS;

    let changes: Changes;
    if (account.syncCursor) {
      try {
        changes = await incremental(api, account.syncCursor);
      } catch (error) {
        if (!(error instanceof HistoryExpiredError)) throw error;
        changes = await backfill(api, cap);
      }
    } else {
      changes = await backfill(api, cap);
    }

    await deps.db.transaction(async (tx) => {
      await persistThreads(tx, deps.encryptor, account, changes.threads, now);
      await deleteThreadsByProviderIds(tx, account.id, changes.vanishedThreadIds);
      await deleteMessagesByProviderIds(tx, account.id, changes.deletedMessageIds);
      await recordSyncSuccess(tx, account.id, changes.cursor, now);
    });
    return { status: "synced", mode: changes.mode, threads: changes.threads.length };
  } catch (error) {
    await recordSyncFailure(deps.db, account.id, describeSyncError(error));
    throw error;
  } finally {
    await releaseSyncLease(deps.db, account.id);
  }
}
