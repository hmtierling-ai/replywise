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
