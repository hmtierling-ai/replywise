import type { MailProviderId } from "@replywise/core";
import { insertAuditLog, mailAccounts } from "@replywise/db";
import { OAuthError } from "@replywise/mail";
import { eq } from "drizzle-orm";
import { clock, type MailboxDeps } from "./deps";
import { ConnectError, MailAccountNotFoundError, ReauthRequiredError } from "./errors";
import { decryptTokens, encryptTokens } from "./tokens-codec";

export const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REAUTH_MESSAGE = "Access was revoked or expired. Reconnect this mailbox.";

type Outcome = { accessToken: string; provider: MailProviderId } | { reauth: true };

/**
 * Returns a usable access token, refreshing it when it expires within 5 minutes.
 * The mailbox row is locked (SELECT … FOR UPDATE) so concurrent callers never refresh twice —
 * important for Microsoft, which rotates refresh tokens.
 */
export async function getValidAccessToken(
  deps: MailboxDeps,
  mailAccountId: string,
): Promise<{ accessToken: string; provider: MailProviderId }> {
  const outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
    const [account] = await tx
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, mailAccountId))
      .for("update");
    if (!account) throw new MailAccountNotFoundError(mailAccountId);
    if (account.status === "needs_reauth") return { reauth: true };

    const now = clock(deps);
    const tokens = await decryptTokens(deps.encryptor, account.id, account.tokensCiphertext);
    if (new Date(tokens.expiresAt).getTime() - REFRESH_SKEW_MS > now.getTime()) {
      return { accessToken: tokens.accessToken, provider: account.provider };
    }

    const provider = deps.providers[account.provider];
    if (!provider) throw new ConnectError("not_configured");

    try {
      const grant = await provider.refresh(tokens, now);
      await tx
        .update(mailAccounts)
        .set({
          tokensCiphertext: await encryptTokens(deps.encryptor, account.id, grant.tokens),
          grantedScopes:
            grant.grantedScopes.length > 0 ? grant.grantedScopes : account.grantedScopes,
          status: "active",
          lastError: null,
        })
        .where(eq(mailAccounts.id, account.id));
      return { accessToken: grant.tokens.accessToken, provider: account.provider };
    } catch (error) {
      if (!(error instanceof OAuthError) || error.code !== "invalid_grant") throw error;
      // Persist the state change, then report it after the transaction commits.
      await tx
        .update(mailAccounts)
        .set({ status: "needs_reauth", lastError: REAUTH_MESSAGE })
        .where(eq(mailAccounts.id, account.id));
      await insertAuditLog(tx, {
        userId: account.userId,
        action: "mailbox.reauth_required",
        targetType: "mail_account",
        targetId: account.id,
        metadata: { provider: account.provider },
      });
      return { reauth: true };
    }
  });

  if ("reauth" in outcome) throw new ReauthRequiredError(mailAccountId);
  return outcome;
}
