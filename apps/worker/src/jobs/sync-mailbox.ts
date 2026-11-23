import type { Logger } from "@replywise/observability";
import { type SyncDeps, syncMailbox } from "@replywise/sync";
import { sanitizeError } from "../log-error";

export function syncMailboxHandler(deps: { syncDeps: SyncDeps; logger: Logger }) {
  return async ({ mailAccountId }: { mailAccountId: string }): Promise<void> => {
    let outcome: Awaited<ReturnType<typeof syncMailbox>>;
    try {
      outcome = await syncMailbox(deps.syncDeps, mailAccountId);
    } catch (error) {
      // BullMQ stores the thrown error's message/stack in Redis; never let email content in.
      throw sanitizeError(error);
    }
    deps.logger.info({ mailAccountId, ...outcome }, "mailbox sync");
  };
}
