import { type Db, purgeExpiredOAuthStates } from "@replywise/db";
import type { Logger } from "@replywise/observability";

export function purgeOAuthStatesHandler(deps: { db: Db; logger: Logger; now?: () => Date }) {
  return async (): Promise<void> => {
    const purged = await purgeExpiredOAuthStates(deps.db, deps.now?.() ?? new Date());
    deps.logger.info({ purged }, "purged expired OAuth states");
  };
}
