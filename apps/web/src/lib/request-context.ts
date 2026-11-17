import type { RequestContext } from "@replywise/mailbox";

/** Audit context from request headers. ip is the leftmost x-forwarded-for, capped at 64 chars. */
export function requestContext(headers: Headers): RequestContext {
  return {
    ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || null,
    userAgent: headers.get("user-agent")?.slice(0, 300) ?? null,
  };
}
