import { parseScopes } from "./scopes";
import type { FetchLike, OAuthTokens, TokenGrant } from "./types";

/** OAuth protocol error (e.g. invalid_grant). Never contains tokens. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly description?: string,
  ) {
    // message is the code only: descriptions are provider-supplied and may contain PII.
    super(code);
    this.name = "OAuthError";
  }
}

/** Non-OAuth API failure (e.g. profile endpoint returned 401). */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly rateLimited = false,
    readonly retryAfterMs?: number,
  ) {
    super(`Provider request failed (${status}) at ${endpoint}`);
    this.name = "ProviderHttpError";
  }
}

/** Upper bound for any single provider HTTP call. */
export const PROVIDER_TIMEOUT_MS = 10_000;

function classify(error: unknown, url: string): unknown {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new ProviderHttpError(0, new URL(url).pathname);
  }
  return error;
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
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw classify(error, url);
  }
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "http_error";
    const description =
      typeof body.error_description === "string" ? body.error_description.slice(0, 200) : undefined;
    throw new OAuthError(code, response.status, description);
  }
  return body;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

function reasonsOf(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.map((item) =>
        item && typeof item === "object" ? (item as { reason?: unknown }).reason : undefined,
      )
    : [];
}

function isRateLimited(status: number, body: Record<string, unknown>): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const error = body.error;
  if (!error || typeof error !== "object") return false;
  const { errors, details } = error as { errors?: unknown; details?: unknown };
  return (
    reasonsOf(errors).some((r) => typeof r === "string" && RATE_LIMIT_REASONS.has(r)) ||
    reasonsOf(details).some((r) => r === "RATE_LIMIT_EXCEEDED")
  );
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim()) * 1000;
}

async function jsonOrThrow(response: Response, url: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const pathname = new URL(url).pathname;
    const body = await readJson(response);
    if (isRateLimited(response.status, body)) {
      throw new ProviderHttpError(
        response.status,
        pathname,
        true,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }
    throw new ProviderHttpError(response.status, pathname);
  }
  return readJson(response);
}

export async function getJson(
  fetchImpl: FetchLike,
  url: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw classify(error, url);
  }
  return jsonOrThrow(response, url);
}

/** JSON write (POST/PUT) with the same timeout and error classification as getJson. */
export async function requestJson(
  fetchImpl: FetchLike,
  method: "POST" | "PUT",
  url: string,
  accessToken: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw classify(error, url);
  }
  return jsonOrThrow(response, url);
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
