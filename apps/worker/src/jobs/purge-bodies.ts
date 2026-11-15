import { type Db, purgeExpiredBodies } from "@replywise/db";
import type { Logger } from "@replywise/observability";

export function purgeBodiesHandler(deps: { db: Db; logger: Logger; now?: () => Date }) {
  return async (): Promise<void> => {
    const now = deps.now?.() ?? new Date();
    const purged = await purgeExpiredBodies(deps.db, now);
    deps.logger.info({ purged }, "purged expired message bodies");
  };
}
