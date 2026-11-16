import type { MailProviderId } from "@replywise/core";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 instant at which the access token expires. */
  expiresAt: string;
}

export interface TokenGrant {
  tokens: OAuthTokens;
  /** Scopes the provider reports as granted; empty when the response omits them. */
  grantedScopes: string[];
}

export interface MailboxProfile {
  email: string;
  displayName: string | null;
}

export interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  loginHint?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * OAuth side of a mail provider. Deliberately has NO send capability (spec §8):
 * Replywise only reads mail and (from M5) creates drafts.
 */
export interface MailOAuthProvider {
  readonly id: MailProviderId;
  /** Scopes that must be granted for the connection to be accepted. */
  readonly requiredScopes: readonly string[];
  /** Whether revoke() really revokes access at the provider. */
  readonly supportsRevocation: boolean;
  buildAuthorizationUrl(request: AuthorizationRequest): string;
  exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string },
    now: Date,
  ): Promise<TokenGrant>;
  refresh(tokens: OAuthTokens, now: Date): Promise<TokenGrant>;
  revoke(tokens: OAuthTokens): Promise<void>;
  getProfile(accessToken: string): Promise<MailboxProfile>;
}
