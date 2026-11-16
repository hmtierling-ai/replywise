import "server-only";
import { MAIL_PROVIDERS, type MailProviderId } from "@replywise/core";
import { createMailOAuthProviders, type MailOAuthProviders } from "@replywise/mail";
import type { MailboxDeps, RequestContext } from "@replywise/mailbox";
import { getEncryptor } from "./crypto";
import { getDb } from "./db";
import { getEnv } from "./env";

let providers: MailOAuthProviders | undefined;

function getProviders(): MailOAuthProviders {
  const env = getEnv();
  providers ??= createMailOAuthProviders({
    gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET },
    outlook: { clientId: env.OUTLOOK_CLIENT_ID, clientSecret: env.OUTLOOK_CLIENT_SECRET },
  });
  return providers;
}

export function getMailboxDeps(): MailboxDeps {
  return { db: getDb(), encryptor: getEncryptor(), providers: getProviders() };
}

export function configuredMailProviders(): MailProviderId[] {
  const enabled = getProviders();
  return MAIL_PROVIDERS.filter((id) => enabled[id] !== undefined);
}

export function oauthCallbackUrl(provider: MailProviderId): string {
  return new URL(`/api/oauth/${provider}/callback`, getEnv().APP_URL).toString();
}

/** Absolute URL on the configured app origin (not the proxy-internal request host). */
export function appUrl(path: string): URL {
  return new URL(path, getEnv().APP_URL);
}

export function requestContext(headers: Headers): RequestContext {
  return {
    ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    userAgent: headers.get("user-agent")?.slice(0, 300) ?? null,
  };
}
