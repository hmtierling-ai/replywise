import { parseScopes } from "./scopes";
import type { FetchLike, OAuthTokens, TokenGrant } from "./types";

/** OAuth protocol error (e.g. invalid_grant). Never contains tokens. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthError";
  }
}

/** Non-OAuth API failure (e.g. profile endpoint returned 401). */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`Provider request failed (${status}) at ${endpoint}`);
    this.name = "ProviderHttpError";
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "http_error";
    const description =
      typeof body.error_description === "string" ? body.error_description.slice(0, 200) : undefined;
    throw new OAuthError(code, response.status, description);
  }
  return body;
}

export async function getJson(
  fetchImpl: FetchLike,
  url: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) throw new ProviderHttpError(response.status, new URL(url).pathname);
  return readJson(response);
}

export function tokenGrantFrom(
  body: Record<string, unknown>,
  now: Date,
  previous?: OAuthTokens,
): TokenGrant {
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new OAuthError("invalid_token_response", 200);
  }
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token !== ""
      ? body.refresh_token
      : previous?.refreshToken;
  if (!refreshToken) throw new OAuthError("missing_refresh_token", 200);
  const expiresIn = Number(body.expires_in ?? 3600);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError("invalid_token_response", 200);
  }
  return {
    tokens: {
      accessToken,
      refreshToken,
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    },
    grantedScopes: parseScopes(typeof body.scope === "string" ? body.scope : undefined),
  };
}
