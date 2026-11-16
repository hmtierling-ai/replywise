import type { DbExecutor } from "../client";
import { auditLogs } from "../schema/audit";

export type AuditAction =
  | "mailbox.connected"
  | "mailbox.reconnected"
  | "mailbox.disconnected"
  | "mailbox.reauth_required";

export interface AuditEntry {
  userId: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Never put email content or secrets here. */
  metadata?: Record<string, unknown>;
}

export async function insertAuditLog(db: DbExecutor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    userId: entry.userId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    metadata: entry.metadata ?? {},
  });
}
