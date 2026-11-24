import {
  AiKeyInvalidError,
  AiOutputError,
  AiRefusalError,
  isRetryableAiError,
} from "@replywise/ai";
import { InvalidRecipientError, ProviderHttpError } from "@replywise/mail";
import { ReauthRequiredError } from "@replywise/mailbox";

/** Fixed code stored in DB error columns; never derived from provider or email text. */
export function errorCode(error: unknown): string {
  if (error instanceof AiKeyInvalidError) return "ai_key_invalid";
  if (error instanceof AiRefusalError) return "ai_refused";
  if (error instanceof AiOutputError) return "ai_bad_output";
  if (isRetryableAiError(error)) return "ai_unavailable";
  if (error instanceof ReauthRequiredError) return "gmail_reauth";
  if (error instanceof InvalidRecipientError) return "no_recipient";
  if (error instanceof ProviderHttpError) return "gmail_unavailable";
  return "internal";
}

/** Rate limits, 5xx and timeouts (status 0) may succeed later; other HTTP failures will not. */
export function isRetryableGmailError(error: unknown): boolean {
  return (
    error instanceof ProviderHttpError &&
    (error.rateLimited || error.status === 0 || error.status >= 500)
  );
}
