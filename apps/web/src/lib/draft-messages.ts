export const GENERATION_ERRORS: Record<string, string> = {
  no_ai_key: "Add a valid Anthropic API key in Settings → AI first.",
  ai_key_invalid: "Anthropic rejected your API key. Update it in Settings → AI.",
  ai_refused: "The model declined this thread. Try different instructions.",
  ai_bad_output: "The model returned an unusable answer. Try again.",
  ai_unavailable: "Anthropic is busy or unreachable. Try again in a moment.",
  gmail_reauth: "Gmail needs to be reconnected (Settings → Mailboxes).",
  gmail_unavailable: "Gmail is busy or unreachable. Try again in a moment.",
  no_recipient: "There is no message from someone else to reply to.",
  internal: "Something went wrong. Try again.",
};

export function generationError(code: string | null): string | null {
  return code ? (GENERATION_ERRORS[code] ?? GENERATION_ERRORS.internal ?? null) : null;
}

/** Copy for send_failed codes written by the worker (spec M6 §2.4). */
export function sendFailure(code: string | null): string {
  if (code === "send_unconfirmed") {
    return "The send may or may not have gone out — check your Gmail Sent folder.";
  }
  if (code === "send_rejected") return "Gmail refused to send this reply. Nothing was sent.";
  return `${generationError(code ?? "internal") ?? GENERATION_ERRORS.internal} Nothing was sent.`;
}

export type SendActionErrorCode =
  | "not_sendable"
  | "draft_changed"
  | "send_rate_limited"
  | "too_late"
  | "send_still_scheduled"
  | "internal";

export const SEND_ACTION_ERRORS: Record<SendActionErrorCode, string> = {
  not_sendable: "This reply can't be sent right now. Reload the page and try again.",
  draft_changed: "The draft changed after you opened this dialog. Review it and confirm again.",
  send_rate_limited: "You've sent 20 replies in the last hour. Try again later.",
  too_late: "Too late to undo: the reply is already being sent.",
  send_still_scheduled:
    "Something went wrong and the reply may still be sent. Reload the page to undo it.",
  internal: "Something went wrong. Nothing was sent. Try again.",
};

export function sendActionError(code: SendActionErrorCode): string {
  return SEND_ACTION_ERRORS[code];
}
