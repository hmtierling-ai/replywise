import type { GmailApiFactory } from "@replywise/mail";
import type { MailboxDeps } from "@replywise/mailbox";

export interface SyncDeps extends MailboxDeps {
  /** Builds a Gmail client for an access token (injectable for tests). */
  gmail: GmailApiFactory;
  /** Overrides MAX_BACKFILL_THREADS (tests). */
  maxBackfillThreads?: number;
  /** Overrides PERSIST_BATCH_SIZE (tests). */
  persistBatchSize?: number;
}
