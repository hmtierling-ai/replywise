import type { AiProvider } from "@replywise/ai";
import type { WorkerEnv } from "@replywise/config";
import { createEncryptor, LocalKeyProvider } from "@replywise/crypto";
import type { Db } from "@replywise/db";
import {
  createGmailApi,
  createGmailDraftsApi,
  createMailOAuthProviders,
  type GmailApiFactory,
  type GmailDraftsFactory,
} from "@replywise/mail";
import type { Logger } from "@replywise/observability";
import type { JobQueue } from "@replywise/queue";
import type { SyncDeps } from "@replywise/sync";
import type { GenerationDeps } from "./jobs/generation-shared";
import type { SaveDraftDeps } from "./jobs/save-draft";

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

/** Deps for the ai queue: reuses the sync deps' encryptor and OAuth providers for token refresh. */
export function buildGenerationDeps(
  syncDeps: SyncDeps,
  logger: Logger,
  queue: JobQueue,
  overrides: { ai: AiProvider; gmailDrafts?: GmailDraftsFactory },
): GenerationDeps & SaveDraftDeps {
  const { db, encryptor, providers } = syncDeps;
  return {
    db,
    encryptor,
    ai: overrides.ai,
    logger,
    queue,
    mailbox: { db, encryptor, providers },
    gmailDrafts: overrides.gmailDrafts ?? ((accessToken) => createGmailDraftsApi(accessToken)),
  };
}
