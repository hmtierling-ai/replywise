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
