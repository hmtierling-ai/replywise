import {
  acquireSyncLease,
  deleteMessagesByProviderIds,
  deleteThreadsByProviderIds,
  deleteThreadsNotIn,
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
import { describeSyncError, SyncDeadlineError } from "./errors";
import { type PersistAccount, persistThreads } from "./persist";

export const SYNC_LEASE_MS = 10 * 60 * 1000;
/** A run stops starting new thread fetches after this long, well inside the lease. */
export const SYNC_DEADLINE_MS = 8 * 60 * 1000;
/** The access token must outlive the whole run (deadline plus the final persist). */
export const SYNC_TOKEN_MIN_VALIDITY_MS = 15 * 60 * 1000;
export const BACKFILL_QUERY = "(in:inbox OR in:sent) newer_than:30d";
export const MAX_BACKFILL_THREADS = 300;
/** Threads fetched and committed per transaction, so progress survives a failed run. */
export const PERSIST_BATCH_SIZE = 50;
const PAGE_SIZE = 100;
const FETCH_CONCURRENCY = 5;

export type SyncOutcome =
  | { status: "synced"; mode: "backfill" | "incremental"; threads: number }
  | { status: "skipped"; reason: "not_found" | "unsupported_provider" | "needs_reauth" | "locked" };

/** What a run will fetch and apply; nothing is written until the batches run. */
interface Plan {
  mode: "backfill" | "incremental";
  threadIds: string[];
  deletedMessageIds: string[];
  cursor: string;
}

async function planBackfill(api: GmailApi, cap: number): Promise<Plan> {
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
  return { mode: "backfill", threadIds: ids, deletedMessageIds: [], cursor: historyId };
}

/** Returns null when more threads changed than `cap`: a bounded re-backfill is cheaper. */
async function planIncremental(
  api: GmailApi,
  startHistoryId: string,
  cap: number,
): Promise<Plan | null> {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let cursor = startHistoryId;
  let pageToken: string | undefined;
  do {
    const page = await api.listHistory({ startHistoryId, ...(pageToken ? { pageToken } : {}) });
    for (const id of page.changedThreadIds) changed.add(id);
    for (const id of page.deletedMessageIds) deleted.add(id);
    if (changed.size > cap) return null;
    cursor = page.historyId;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return {
    mode: "incremental",
    threadIds: [...changed],
    deletedMessageIds: [...deleted],
    cursor,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks.length > 0 ? chunks : [[]];
}

/**
 * Fetches and persists the plan batch by batch, each batch in its own transaction. Only the
 * final transaction applies deletions and pruning and advances the cursor, so an interrupted
 * run keeps its committed batches and simply replays from the old cursor next time.
 */
async function applyPlan(
  deps: SyncDeps,
  api: GmailApi,
  account: PersistAccount,
  plan: Plan,
  now: Date,
  deadline: number,
): Promise<number> {
  const batches = chunk(plan.threadIds, deps.persistBatchSize ?? PERSIST_BATCH_SIZE);
  let stored = 0;
  for (const [index, ids] of batches.entries()) {
    const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, (id) => {
      if (clock(deps).getTime() >= deadline) throw new SyncDeadlineError();
      return api.getThread(id);
    });
    const threads = fetched.filter((t): t is ParsedThread => t !== null);
    const vanished = ids.filter((_, i) => fetched[i] === null);
    const last = index === batches.length - 1;
    await deps.db.transaction(async (tx) => {
      await persistThreads(tx, deps.encryptor, account, threads, now);
      await deleteThreadsByProviderIds(tx, account.id, vanished);
      if (!last) return;
      await deleteMessagesByProviderIds(tx, account.id, plan.deletedMessageIds);
      // A completed backfill is the full picture: drop local threads it no longer includes.
      if (plan.mode === "backfill") await deleteThreadsNotIn(tx, account.id, plan.threadIds);
      await recordSyncSuccess(tx, account.id, plan.cursor, now);
    });
    stored += threads.length;
  }
  return stored;
}

/** Syncs one Gmail mailbox. Safe to call concurrently: a DB lease admits one run at a time. */
export async function syncMailbox(deps: SyncDeps, mailAccountId: string): Promise<SyncOutcome> {
  const now = clock(deps);
  const deadline = now.getTime() + SYNC_DEADLINE_MS;
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
  const lease = await acquireSyncLease(deps.db, account.id, now, SYNC_LEASE_MS);
  if (!lease) return { status: "skipped", reason: "locked" };

  try {
    let accessToken: string;
    try {
      ({ accessToken } = await getValidAccessToken(deps, account.id, {
        minValidityMs: SYNC_TOKEN_MIN_VALIDITY_MS,
      }));
    } catch (error) {
      if (error instanceof ReauthRequiredError)
        return { status: "skipped", reason: "needs_reauth" };
      throw error;
    }
    const api = deps.gmail(accessToken);
    const cap = deps.maxBackfillThreads ?? MAX_BACKFILL_THREADS;

    let plan: Plan | null = null;
    if (account.syncCursor) {
      try {
        plan = await planIncremental(api, account.syncCursor, cap);
      } catch (error) {
        if (!(error instanceof HistoryExpiredError)) throw error;
      }
    }
    plan ??= await planBackfill(api, cap);

    const threads = await applyPlan(deps, api, account, plan, now, deadline);
    return { status: "synced", mode: plan.mode, threads };
  } catch (error) {
    await recordSyncFailure(deps.db, account.id, describeSyncError(error));
    throw error;
  } finally {
    await releaseSyncLease(deps.db, account.id, lease);
  }
}
