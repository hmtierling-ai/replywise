import { OAuthError, ProviderHttpError } from "@replywise/mail";

export interface SafeErrorFields {
  name: string;
  message?: string;
  code?: string;
}

/**
 * The only error fields a worker log line may carry. Provider and OAuth errors have fixed,
 * non-secret messages. Anything else (notably DrizzleQueryError, whose message embeds the SQL
 * parameters: subjects, snippets, addresses, ciphertext) is reduced to its name plus the
 * SQLSTATE from `cause.code`. Never returns `.message` or `.stack` of an unknown error.
 */
export function safeErrorFields(error: unknown): SafeErrorFields {
  if (error instanceof ProviderHttpError || error instanceof OAuthError) {
    return { name: error.name, message: error.message };
  }
  const name = error instanceof Error ? error.name : typeof error;
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? { name, code: cause.code } : { name };
}

/**
 * Error safe to hand to BullMQ, which persists `message` and `stack` in Redis as the failed
 * reason. Provider/OAuth errors pass through (fixed messages); anything else is replaced by an
 * error carrying only the safe fields, so query parameters never reach Redis.
 */
export function sanitizeError(error: unknown): Error {
  if (error instanceof ProviderHttpError || error instanceof OAuthError) return error;
  const { name, code } = safeErrorFields(error);
  const safe = new Error(code ? `${name} (${code})` : name);
  safe.name = name;
  return safe;
}
