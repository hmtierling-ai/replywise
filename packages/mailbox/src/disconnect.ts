import type { MailProviderId } from "@replywise/core";
import { deleteMailAccountForUser, getMailAccountForUser, insertAuditLog } from "@replywise/db";
import type { MailboxDeps, RequestContext } from "./deps";
import { MailAccountNotFoundError } from "./errors";
import { decryptTokens } from "./tokens-codec";

/**
 * Revokes provider access when supported (best effort), then deletes the mailbox and all
 * of its synced data (FK cascade), and audits the change.
 */
export async function disconnectMailbox(
  deps: MailboxDeps,
  input: { userId: string; mailAccountId: string; context?: RequestContext },
): Promise<{ provider: MailProviderId; revoked: boolean }> {
  const account = await getMailAccountForUser(deps.db, input.userId, input.mailAccountId);
  if (!account) throw new MailAccountNotFoundError(input.mailAccountId);

  let revoked = false;
  const provider = deps.providers[account.provider];
  if (provider?.supportsRevocation) {
    try {
      await provider.revoke(
        await decryptTokens(deps.encryptor, account.id, account.tokensCiphertext),
      );
      revoked = true;
    } catch {
      revoked = false;
    }
  }

  await deps.db.transaction(async (tx) => {
    const deleted = await deleteMailAccountForUser(tx, input.userId, account.id);
    if (!deleted) throw new MailAccountNotFoundError(account.id);
    await insertAuditLog(tx, {
      userId: input.userId,
      action: "mailbox.disconnected",
      targetType: "mail_account",
      targetId: account.id,
      ip: input.context?.ip ?? null,
      userAgent: input.context?.userAgent ?? null,
      metadata: { provider: account.provider, revoked },
    });
  });

  return { provider: account.provider, revoked };
}
