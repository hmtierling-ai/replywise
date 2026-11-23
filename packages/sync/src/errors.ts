import { OAuthError, ProviderHttpError } from "@replywise/mail";

/** A sync run passed its deadline; batches persisted before it are kept, the cursor is not. */
export class SyncDeadlineError extends Error {
  constructor() {
    super("Sync deadline passed");
    this.name = "SyncDeadlineError";
  }
}

/** Fixed, non-secret text for mail_accounts.last_error. Never includes provider messages. */
export function describeSyncError(error: unknown): string {
  if (error instanceof SyncDeadlineError) {
    return "Sync is taking longer than expected; will continue on the next sync";
  }
  if (error instanceof ProviderHttpError) {
    if (error.rateLimited) return "Gmail rate limit reached; will retry on the next sync";
    return error.status === 0
      ? "Gmail API timed out"
      : `Gmail API request failed (${error.status})`;
  }
  if (error instanceof OAuthError) return `Token refresh failed (${error.code})`;
  return "Sync failed unexpectedly";
}
