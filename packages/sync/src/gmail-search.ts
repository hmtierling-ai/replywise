import type { EmailAddress } from "@replywise/core";
import { findLocalThreadIds, getMailAccountForUser, type MailAccount } from "@replywise/db";
import { clock, getValidAccessToken, MailAccountNotFoundError } from "@replywise/mailbox";
import { mapWithConcurrency } from "./concurrency";
import type { SyncDeps } from "./deps";
import { persistThreads } from "./persist";

export const GMAIL_QUERY_MAX_CHARS = 200;
export const GMAIL_SEARCH_MAX_RESULTS = 20;
const METADATA_CONCURRENCY = 5;

export interface GmailSearchResult {
  providerThreadId: string;
  subject: string;
  from: EmailAddress;
  date: Date;
  snippet: string;
  /** Set when the thread is already stored in Replywise. */
  localThreadId: string | null;
}

/** The user's own Gmail mailbox; anything else is reported as not found. */
async function ownedGmailMailbox(
  deps: SyncDeps,
  userId: string,
  mailAccountId: string,
): Promise<MailAccount> {
  const account = await getMailAccountForUser(deps.db, userId, mailAccountId);
  if (account?.provider !== "gmail") throw new MailAccountNotFoundError(mailAccountId);
  return account;
}

/**
 * "Search all of Gmail" (spec M6 §5.2): Gmail query syntax, 20 threads, metadata only. The query
 * goes straight to Gmail and is never logged or stored.
 */
export async function searchGmailThreads(
  deps: SyncDeps,
  input: { userId: string; mailAccountId: string; query: string },
): Promise<GmailSearchResult[]> {
  const account = await ownedGmailMailbox(deps, input.userId, input.mailAccountId);
  const query = input.query.trim().slice(0, GMAIL_QUERY_MAX_CHARS);
  // Outside any transaction: a token refresh may call the provider.
  const { accessToken } = await getValidAccessToken(deps, account.id);
  const api = deps.gmail(accessToken);
  const { ids } = await api.listThreadIds({ query, maxResults: GMAIL_SEARCH_MAX_RESULTS });
  const metadata = await mapWithConcurrency(ids, METADATA_CONCURRENCY, (id) =>
    api.getThreadMetadata(id),
  );
  const local = await findLocalThreadIds(deps.db, account.id, ids);
  return metadata.flatMap((m) =>
    m ? [{ ...m, localThreadId: local.get(m.providerThreadId) ?? null }] : [],
  );
}

/**
 * Fetches one Gmail thread and stores it through the sync persistence path (spec M6 §5.2). A
 * later re-backfill may prune it when it is outside the backfill window; it can be imported again.
 */
export async function importThread(
  deps: SyncDeps,
  input: { userId: string; mailAccountId: string; providerThreadId: string },
): Promise<string | null> {
  const account = await ownedGmailMailbox(deps, input.userId, input.mailAccountId);
  const { accessToken } = await getValidAccessToken(deps, account.id);
  const thread = await deps.gmail(accessToken).getThread(input.providerThreadId);
  if (!thread) return null;
  const owner = { id: account.id, userId: account.userId, emailAddress: account.emailAddress };
  await deps.db.transaction((tx) =>
    persistThreads(tx, deps.encryptor, owner, [thread], clock(deps)),
  );
  const local = await findLocalThreadIds(deps.db, account.id, [input.providerThreadId]);
  return local.get(input.providerThreadId) ?? null;
}
