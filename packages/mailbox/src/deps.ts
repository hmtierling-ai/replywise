import type { Encryptor } from "@replywise/crypto";
import type { Db } from "@replywise/db";
import type { MailOAuthProviders } from "@replywise/mail";

export interface MailboxDeps {
  db: Db;
  encryptor: Encryptor;
  providers: MailOAuthProviders;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

export function clock(deps: MailboxDeps): Date {
  return deps.now?.() ?? new Date();
}
