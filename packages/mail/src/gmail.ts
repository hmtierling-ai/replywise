import { getJson, ProviderHttpError, postForm, tokenGrantFrom } from "./http";
import type { FetchLike, MailOAuthProvider } from "./types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
}

export function createGmailOAuth(config: GmailOAuthConfig): MailOAuthProvider {
  const fetchImpl: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));

  return {
    id: "gmail",
    requiredScopes: GMAIL_SCOPES,
    supportsRevocation: true,

    buildAuthorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GMAIL_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, redirectUri }, now) {
      const body = await postForm(fetchImpl, TOKEN_URL, {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      return tokenGrantFrom(body, now);
    },

    async refresh(tokens, now) {
      const body = await postForm(fetchImpl, TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      return tokenGrantFrom(body, now, tokens);
    },

    async revoke(tokens) {
      await postForm(fetchImpl, REVOKE_URL, { token: tokens.refreshToken });
    },

    async getProfile(accessToken) {
      const body = await getJson(fetchImpl, PROFILE_URL, accessToken);
      if (typeof body.emailAddress !== "string") {
        throw new ProviderHttpError(200, new URL(PROFILE_URL).pathname);
      }
      return { email: body.emailAddress.toLowerCase(), displayName: null };
    },
  };
}
