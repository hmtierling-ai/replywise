import { getJson, ProviderHttpError, postForm, tokenGrantFrom } from "./http";
import type { FetchLike, MailOAuthProvider } from "./types";

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const PROFILE_URL =
  "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName";

/** Requested scopes. No send permission is ever requested (spec §5). */
export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite"] as const;
/** Graph does not always echo offline_access, so only these are verified. */
const VERIFIED_SCOPES = ["User.Read", "Mail.ReadWrite"] as const;

export interface OutlookOAuthConfig {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
}

export function createOutlookOAuth(config: OutlookOAuthConfig): MailOAuthProvider {
  const fetchImpl: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
  const scope = OUTLOOK_SCOPES.join(" ");

  return {
    id: "outlook",
    requiredScopes: VERIFIED_SCOPES,
    // Microsoft has no per-app revocation endpoint; users remove access in their account settings.
    supportsRevocation: false,

    buildAuthorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const url = new URL(`${AUTHORITY}/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, redirectUri }, now) {
      const body = await postForm(fetchImpl, `${AUTHORITY}/token`, {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        scope,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      return tokenGrantFrom(body, now);
    },

    async refresh(tokens, now) {
      const body = await postForm(fetchImpl, `${AUTHORITY}/token`, {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        scope,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      return tokenGrantFrom(body, now, tokens);
    },

    async revoke() {
      // Intentionally a no-op: see supportsRevocation.
    },

    async getProfile(accessToken) {
      const body = await getJson(fetchImpl, PROFILE_URL, accessToken);
      const email =
        typeof body.mail === "string" && body.mail !== ""
          ? body.mail
          : typeof body.userPrincipalName === "string"
            ? body.userPrincipalName
            : null;
      if (!email) throw new ProviderHttpError(200, "/v1.0/me");
      return {
        email: email.toLowerCase(),
        displayName: typeof body.displayName === "string" ? body.displayName : null,
      };
    },
  };
}
