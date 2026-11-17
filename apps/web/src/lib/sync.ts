import "server-only";
import { createGmailApi } from "@replywise/mail";
import type { SyncDeps } from "@replywise/sync";
import { getMailboxDeps } from "./mailbox";

export function getSyncDeps(): SyncDeps {
  return { ...getMailboxDeps(), gmail: (accessToken) => createGmailApi(accessToken) };
}
