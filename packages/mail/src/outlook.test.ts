import { describe, expect, it } from "vitest";
import type { OAuthError } from "./http";
import { createOutlookOAuth, OUTLOOK_SCOPES } from "./outlook";
import { createMailOAuthProviders } from "./registry";
import type { FetchLike } from "./types";

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: URLSearchParams | null;
  }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? new URLSearchParams(init.body) : null,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const NOW = new Date("2026-11-16T12:00:00.000Z");
const config = { clientId: "ms-client", clientSecret: "ms-secret" };

describe("Outlook OAuth provider", () => {
  it("builds an authorization URL without any send permission", () => {
    const outlook = createOutlookOAuth(config);
    const url = new URL(
      outlook.buildAuthorizationUrl({
        state: "s",
        codeChallenge: "c",
        redirectUri: "http://localhost:3000/api/oauth/outlook/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toEqual([...OUTLOOK_SCOPES]);
    expect(scopes.map((s) => s.toLowerCase())).not.toContain("mail.send");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(outlook.requiredScopes).toEqual(["User.Read", "Mail.ReadWrite"]);
  });

  it("stores the rotated refresh token and accepts prefixed Graph scopes", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          access_token: "eyJ.new",
          refresh_token: "M.rotated",
          expires_in: 3600,
          scope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read",
        },
      },
    ]);
    const outlook = createOutlookOAuth({ ...config, fetch: fetchImpl });
    const grant = await outlook.refresh(
      { accessToken: "old", refreshToken: "M.old", expiresAt: NOW.toISOString() },
      NOW,
    );
    expect(grant.tokens.refreshToken).toBe("M.rotated");
    expect(calls[0]?.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(calls[0]?.body?.get("scope")).toBe(OUTLOOK_SCOPES.join(" "));
    expect(grant.grantedScopes).toHaveLength(2);
  });

  it("maps invalid_grant to OAuthError", async () => {
    const { fetchImpl } = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    const outlook = createOutlookOAuth({ ...config, fetch: fetchImpl });
    await expect(
      outlook.refresh({ accessToken: "a", refreshToken: "r", expiresAt: NOW.toISOString() }, NOW),
    ).rejects.toMatchObject({ code: "invalid_grant" } satisfies Partial<OAuthError>);
  });

  it("reads mail, falling back to userPrincipalName, and does not pretend to revoke", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { mail: null, userPrincipalName: "Person@Outlook.com", displayName: "Person" } },
    ]);
    const outlook = createOutlookOAuth({ ...config, fetch: fetchImpl });
    expect(await outlook.getProfile("eyJ.token")).toEqual({
      email: "person@outlook.com",
      displayName: "Person",
    });
    expect(calls[0]?.url).toContain("https://graph.microsoft.com/v1.0/me");
    await outlook.revoke({ accessToken: "a", refreshToken: "r", expiresAt: NOW.toISOString() });
    expect(calls).toHaveLength(1);
    expect(outlook.supportsRevocation).toBe(false);
  });
});

describe("createMailOAuthProviders", () => {
  it("enables only providers with both client id and secret", () => {
    const providers = createMailOAuthProviders({
      gmail: { clientId: "g", clientSecret: "gs" },
      outlook: { clientId: "o", clientSecret: undefined },
    });
    expect(Object.keys(providers)).toEqual(["gmail"]);
    expect(providers.gmail?.id).toBe("gmail");
  });
});
