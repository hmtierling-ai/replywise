import { OAuthError, ProviderHttpError } from "@replywise/mail";

/** Fixed, non-secret text for mail_accounts.last_error. Never includes provider messages. */
export function describeSyncError(error: unknown): string {
  if (error instanceof ProviderHttpError) {
    if (error.rateLimited) return "Gmail rate limit reached; will retry on the next sync";
    return error.status === 0
      ? "Gmail API timed out"
      : `Gmail API request failed (${error.status})`;
  }
  if (error instanceof OAuthError) return `Token refresh failed (${error.code})`;
  return "Sync failed unexpectedly";
}
