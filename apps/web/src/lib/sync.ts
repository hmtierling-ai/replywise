import "server-only";
import { createGmailApi, type GmailApiOptions } from "@replywise/mail";
import type { SyncDeps } from "@replywise/sync";
import { getEnv } from "./env";
import { getMailboxDeps } from "./mailbox";

/** Gmail origin override for e2e (loopback only; validated by the env schema). */
function gmailOrigin(): Pick<GmailApiOptions, "baseUrl"> {
  const url = getEnv().E2E_FAKE_GMAIL_URL;
  return url ? { baseUrl: url } : {};
}

export function getSyncDeps(): SyncDeps {
  return {
    ...getMailboxDeps(),
    gmail: (accessToken) => createGmailApi(accessToken, gmailOrigin()),
  };
}

/**
 * Interactive "Search all of Gmail": one short burst per click (list + 20 metadata reads), so a
 * faster pacer than sync and a single rate-limit retry keep the page responsive.
 */
export function getGmailSearchDeps(): SyncDeps {
  return {
    ...getMailboxDeps(),
    gmail: (accessToken) =>
      createGmailApi(accessToken, { ...gmailOrigin(), unitsPerSecond: 200, maxRetries: 1 }),
  };
}
