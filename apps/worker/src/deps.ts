import type { WorkerEnv } from "@replywise/config";
import { createEncryptor, LocalKeyProvider } from "@replywise/crypto";
import type { Db } from "@replywise/db";
import { createGmailApi, createMailOAuthProviders, type GmailApiFactory } from "@replywise/mail";
import type { SyncDeps } from "@replywise/sync";

export function buildSyncDeps(env: WorkerEnv, db: Db, gmail?: GmailApiFactory): SyncDeps {
  return {
    db,
    encryptor: createEncryptor(LocalKeyProvider.fromEnv(env.LOCAL_KEKS)),
    providers: createMailOAuthProviders({
      gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET },
      outlook: { clientId: env.OUTLOOK_CLIENT_ID, clientSecret: env.OUTLOOK_CLIENT_SECRET },
    }),
    gmail: gmail ?? ((accessToken) => createGmailApi(accessToken)),
  };
}
