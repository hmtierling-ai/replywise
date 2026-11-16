import { describe, expect, it } from "vitest";
import { createGmailOAuth, GMAIL_SCOPES } from "./gmail";
import { OAuthError, ProviderHttpError } from "./http";
import type { FetchLike } from "./types";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams | null;
}

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? new URLSearchParams(init.body) : null,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const NOW = new Date("2026-11-16T12:00:00.000Z");
const config = { clientId: "client-123", clientSecret: "secret-456" };

describe("Gmail OAuth provider", () => {
  it("builds an authorization URL with PKCE, offline access and minimal scopes", () => {
    const gmail = createGmailOAuth(config);
    const url = new URL(
      gmail.buildAuthorizationUrl({
        state: "state-abc",
        codeChallenge: "challenge-xyz",
        redirectUri: "http://localhost:3000/api/oauth/gmail/callback",
        loginHint: "me@gmail.com",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("client-123");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/gmail/callback");
    expect(p.get("scope")?.split(" ")).toEqual([...GMAIL_SCOPES]);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("state")).toBe("state-abc");
    expect(p.get("code_challenge")).toBe("challenge-xyz");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("login_hint")).toBe("me@gmail.com");
    expect(url.toString()).not.toContain("secret-456");
  });

  it("exchanges a code for tokens", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          access_token: "ya29.access",
          refresh_token: "1//refresh",
          expires_in: 3599,
          scope: GMAIL_SCOPES.join(" "),
          token_type: "Bearer",
        },
      },
    ]);
    const gmail = createGmailOAuth({ ...config, fetch: fetchImpl });
    const grant = await gmail.exchangeCode(
      { code: "auth-code", codeVerifier: "verifier", redirectUri: "http://cb" },
      NOW,
    );
    expect(grant.tokens).toEqual({
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      expiresAt: "2026-11-16T12:59:59.000Z",
    });
    expect(grant.grantedScopes).toEqual([...GMAIL_SCOPES]);
    const call = calls[0];
    expect(call?.url).toBe("https://oauth2.googleapis.com/token");
    expect(call?.method).toBe("POST");
    expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(call?.body ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      code_verifier: "verifier",
      redirect_uri: "http://cb",
      client_id: "client-123",
      client_secret: "secret-456",
    });
  });

  it("keeps the previous refresh token when Google omits it on refresh", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { access_token: "ya29.new", expires_in: 3600, scope: GMAIL_SCOPES.join(" ") } },
    ]);
    const gmail = createGmailOAuth({ ...config, fetch: fetchImpl });
    const grant = await gmail.refresh(
      { accessToken: "old", refreshToken: "1//keep", expiresAt: NOW.toISOString() },
      NOW,
    );
    expect(grant.tokens.refreshToken).toBe("1//keep");
    expect(grant.tokens.accessToken).toBe("ya29.new");
    expect(calls[0]?.body?.get("grant_type")).toBe("refresh_token");
    expect(calls[0]?.body?.get("refresh_token")).toBe("1//keep");
  });

  it("surfaces OAuth errors by code without leaking tokens", async () => {
    const { fetchImpl } = fakeFetch([
      {
        status: 400,
        body: { error: "invalid_grant", error_description: "Token has been revoked." },
      },
    ]);
    const gmail = createGmailOAuth({ ...config, fetch: fetchImpl });
    const failure = gmail.refresh(
      { accessToken: "old", refreshToken: "1//secret-refresh", expiresAt: NOW.toISOString() },
      NOW,
    );
    await expect(failure).rejects.toBeInstanceOf(OAuthError);
    await expect(failure).rejects.toMatchObject({ code: "invalid_grant", status: 400 });
    await expect(failure).rejects.not.toThrow(/secret-refresh/);
  });

  it("revokes with the refresh token and reads the profile email", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: {} },
      { body: { emailAddress: "Me@Gmail.com", messagesTotal: 10 } },
    ]);
    const gmail = createGmailOAuth({ ...config, fetch: fetchImpl });
    await gmail.revoke({ accessToken: "a", refreshToken: "1//r", expiresAt: NOW.toISOString() });
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(calls[0]?.body?.get("token")).toBe("1//r");

    const profile = await gmail.getProfile("ya29.access");
    expect(profile).toEqual({ email: "me@gmail.com", displayName: null });
    expect(calls[1]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(calls[1]?.headers.authorization).toBe("Bearer ya29.access");
    expect(gmail.supportsRevocation).toBe(true);
  });

  it("raises ProviderHttpError when the profile request fails", async () => {
    const { fetchImpl } = fakeFetch([{ status: 401, body: { error: { code: 401 } } }]);
    const gmail = createGmailOAuth({ ...config, fetch: fetchImpl });
    await expect(gmail.getProfile("expired")).rejects.toBeInstanceOf(ProviderHttpError);
  });
});
