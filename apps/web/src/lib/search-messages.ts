export type GmailSearchErrorCode =
  | "invalid_query"
  | "needs_reauth"
  | "rate_limited"
  | "gmail_error";

export const GMAIL_SEARCH_ERRORS: Record<GmailSearchErrorCode, string> = {
  invalid_query: "Enter a Gmail search of up to 200 characters.",
  needs_reauth: "Gmail needs to be reconnected (Settings → Mailboxes).",
  rate_limited: "Too many Gmail searches right now. Wait a moment and try again.",
  gmail_error: "Gmail couldn't be searched right now. Try again.",
};

/** Fixed code for a failed Gmail search or import; provider text never reaches the UI. */
export function gmailSearchErrorCode(error: unknown): GmailSearchErrorCode {
  if (!(error instanceof Error)) return "gmail_error";
  if (error.name === "ReauthRequiredError") return "needs_reauth";
  if (error.name === "ProviderHttpError" && (error as { rateLimited?: unknown }).rateLimited) {
    return "rate_limited";
  }
  return "gmail_error";
}
