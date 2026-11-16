import type { MailProviderId } from "@replywise/core";
import { createEncryptor, type Encryptor, LocalKeyProvider } from "@replywise/crypto";
import {
  type AuthorizationRequest,
  type MailOAuthProvider,
  OAuthError,
  type OAuthTokens,
} from "@replywise/mail";

export const FAKE_REQUIRED_SCOPES = ["scope.read", "scope.compose"];

export interface FakeProviderOptions {
  email?: string;
  grantedScopes?: string[];
  tokenLifetimeMs?: number;
  /** OAuth error code thrown by refresh(), e.g. "invalid_grant". */
  refreshError?: string;
  supportsRevocation?: boolean;
  /** Artificial latency for refresh(), to exercise the row lock. */
  refreshDelayMs?: number;
}

export function createFakeProvider(
  id: MailProviderId = "gmail",
  options: FakeProviderOptions = {},
) {
  const calls = {
    exchange: 0,
    refresh: 0,
    revoke: 0,
    lastCodeVerifier: "",
    lastAuthorization: null as AuthorizationRequest | null,
  };
  let counter = 0;
  const issue = (now: Date): OAuthTokens => {
    counter += 1;
    return {
      accessToken: `access-${counter}`,
      refreshToken: `refresh-${counter}`,
      expiresAt: new Date(now.getTime() + (options.tokenLifetimeMs ?? 3_600_000)).toISOString(),
    };
  };

  const provider: MailOAuthProvider = {
    id,
    requiredScopes: FAKE_REQUIRED_SCOPES,
    supportsRevocation: options.supportsRevocation ?? true,
    buildAuthorizationUrl(request) {
      calls.lastAuthorization = request;
      const url = new URL("https://auth.example.test/authorize");
      url.searchParams.set("state", request.state);
      url.searchParams.set("code_challenge", request.codeChallenge);
      return url.toString();
    },
    async exchangeCode(input, now) {
      calls.exchange += 1;
      calls.lastCodeVerifier = input.codeVerifier;
      if (input.code === "bad-code") throw new OAuthError("invalid_grant", 400);
      return { tokens: issue(now), grantedScopes: options.grantedScopes ?? FAKE_REQUIRED_SCOPES };
    },
    async refresh(_tokens, now) {
      calls.refresh += 1;
      if (options.refreshDelayMs) await new Promise((r) => setTimeout(r, options.refreshDelayMs));
      if (options.refreshError) throw new OAuthError(options.refreshError, 400);
      return { tokens: issue(now), grantedScopes: [] };
    },
    async revoke() {
      calls.revoke += 1;
    },
    async getProfile() {
      return { email: options.email ?? "person@example.com", displayName: "Person" };
    },
  };
  return { provider, calls };
}

export function testEncryptor(): Encryptor {
  return createEncryptor(LocalKeyProvider.fromEnv(`v1:${Buffer.alloc(32, 3).toString("base64")}`));
}
