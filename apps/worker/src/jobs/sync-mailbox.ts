import type { Logger } from "@replywise/observability";
import { type SyncDeps, syncMailbox } from "@replywise/sync";

export function syncMailboxHandler(deps: { syncDeps: SyncDeps; logger: Logger }) {
  return async ({ mailAccountId }: { mailAccountId: string }): Promise<void> => {
    const outcome = await syncMailbox(deps.syncDeps, mailAccountId);
    deps.logger.info({ mailAccountId, ...outcome }, "mailbox sync");
  };
}
