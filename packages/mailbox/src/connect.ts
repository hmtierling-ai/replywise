import { randomUUID } from "node:crypto";
import type { MailProviderId } from "@replywise/core";
import { aad } from "@replywise/crypto";
import { consumeOAuthState, insertAuditLog, insertOAuthState, mailAccounts } from "@replywise/db";
import {
  codeChallengeS256,
  hashState,
  type MailOAuthProvider,
  missingScopes,
  randomToken,
  type TokenGrant,
} from "@replywise/mail";
import { and, eq } from "drizzle-orm";
import { clock, type MailboxDeps, type RequestContext } from "./deps";
import { ConnectError } from "./errors";
import { encryptTokens } from "./tokens-codec";

export const MAILBOXES_PATH = "/settings/mailboxes";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function providerFor(deps: MailboxDeps, id: MailProviderId): MailOAuthProvider {
  const provider = deps.providers[id];
  if (!provider) throw new ConnectError("not_configured");
  return provider;
}

/** Creates a single-use state and returns the provider's authorization URL. */
export async function startConnect(
  deps: MailboxDeps,
  input: { userId: string; provider: MailProviderId; redirectUri: string; loginHint?: string },
): Promise<string> {
  const provider = providerFor(deps, input.provider);
  const state = randomToken();
  const codeVerifier = randomToken(48);
  const stateHash = hashState(state);

  await insertOAuthState(deps.db, {
    stateHash,
    userId: input.userId,
    provider: input.provider,
    codeVerifierCiphertext: await deps.encryptor.encrypt(
      codeVerifier,
      aad.oauthVerifier(stateHash),
    ),
    returnTo: MAILBOXES_PATH,
    expiresAt: new Date(clock(deps).getTime() + OAUTH_STATE_TTL_MS),
  });

  return provider.buildAuthorizationUrl({
    state,
    codeChallenge: codeChallengeS256(codeVerifier),
    redirectUri: input.redirectUri,
    ...(input.loginHint ? { loginHint: input.loginHint } : {}),
  });
}

export interface CompleteConnectInput {
  userId: string;
  provider: MailProviderId;
  code: string;
  state: string;
  redirectUri: string;
  context?: RequestContext;
}

export async function completeConnect(
  deps: MailboxDeps,
  input: CompleteConnectInput,
): Promise<{ mailAccountId: string; emailAddress: string; reconnected: boolean }> {
  const provider = providerFor(deps, input.provider);
  const now = clock(deps);
  const stateHash = hashState(input.state);

  const stored = await consumeOAuthState(deps.db, stateHash);
  if (!stored || stored.userId !== input.userId) throw new ConnectError("invalid_state");
  if (stored.provider !== input.provider) throw new ConnectError("provider_mismatch");
  if (stored.expiresAt.getTime() <= now.getTime()) throw new ConnectError("expired_state");

  const codeVerifier = await deps.encryptor.decryptString(
    stored.codeVerifierCiphertext,
    aad.oauthVerifier(stateHash),
  );

  let grant: TokenGrant;
  try {
    grant = await provider.exchangeCode(
      { code: input.code, codeVerifier, redirectUri: input.redirectUri },
      now,
    );
  } catch (error) {
    throw new ConnectError("provider_error", error instanceof Error ? error.name : undefined);
  }

  const missing = missingScopes(grant.grantedScopes, provider.requiredScopes);
  if (missing.length > 0) {
    await provider.revoke(grant.tokens).catch(() => undefined);
    throw new ConnectError("missing_scopes", missing.join(" "));
  }

  let profile: Awaited<ReturnType<MailOAuthProvider["getProfile"]>>;
  try {
    profile = await provider.getProfile(grant.tokens.accessToken);
  } catch (error) {
    throw new ConnectError("provider_error", error instanceof Error ? error.name : undefined);
  }

  return deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.userId, input.userId),
          eq(mailAccounts.provider, input.provider),
          eq(mailAccounts.emailAddress, profile.email),
        ),
      )
      .for("update");

    const mailAccountId = existing?.id ?? randomUUID();
    const tokensCiphertext = await encryptTokens(deps.encryptor, mailAccountId, grant.tokens);

    if (existing) {
      await tx
        .update(mailAccounts)
        .set({
          tokensCiphertext,
          grantedScopes: grant.grantedScopes,
          displayName: profile.displayName,
          status: "active",
          lastError: null,
        })
        .where(eq(mailAccounts.id, mailAccountId));
    } else {
      await tx.insert(mailAccounts).values({
        id: mailAccountId,
        userId: input.userId,
        provider: input.provider,
        emailAddress: profile.email,
        displayName: profile.displayName,
        grantedScopes: grant.grantedScopes,
        tokensCiphertext,
      });
    }

    await insertAuditLog(tx, {
      userId: input.userId,
      action: existing ? "mailbox.reconnected" : "mailbox.connected",
      targetType: "mail_account",
      targetId: mailAccountId,
      ip: input.context?.ip ?? null,
      userAgent: input.context?.userAgent ?? null,
      metadata: { provider: input.provider },
    });

    return { mailAccountId, emailAddress: profile.email, reconnected: Boolean(existing) };
  });
}
