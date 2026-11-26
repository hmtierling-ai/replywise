import { type AuditAction, type Db, insertAuditLog } from "@replywise/db";
import type { Logger } from "@replywise/observability";
import { safeErrorFields } from "../log-error";

export type SendAuditMetadata = {
  draftId: string;
  threadId: string;
  mailAccountId: string;
  /** Fixed error code, failures only. */
  error?: string;
};

/**
 * Best-effort audit entry for a send (spec M6 §2.2): ids plus a fixed error code, never the body
 * or recipients. A failed write is logged, never thrown, so it cannot turn into a job retry.
 */
export async function writeSendAudit(
  deps: { db: Db; logger: Logger },
  userId: string,
  action: AuditAction,
  metadata: SendAuditMetadata,
): Promise<void> {
  await insertAuditLog(deps.db, {
    userId,
    action,
    targetType: "reply_draft",
    targetId: metadata.draftId,
    metadata,
  }).catch((error: unknown) => {
    deps.logger.warn(
      { draftId: metadata.draftId, error: safeErrorFields(error) },
      "audit entry not written",
    );
  });
}
