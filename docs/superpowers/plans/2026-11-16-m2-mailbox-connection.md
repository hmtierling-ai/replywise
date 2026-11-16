# Replywise M2 — Mailbox Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user can connect, reconnect and disconnect Gmail and Outlook mailboxes through OAuth 2.0 (Authorization Code + PKCE); tokens are stored envelope-encrypted, refreshed safely under a lock, and every connection change is audit-logged.

**Architecture:** A new `@replywise/mail` package holds provider OAuth adapters (pure HTTP via an injectable `fetch`, no send capability). A new `@replywise/mailbox` package holds the domain services (`startConnect`, `completeConnect`, `getValidAccessToken`, `disconnectMailbox`) on top of `@replywise/db` and `@replywise/crypto`. The web app exposes a Server Action to start a connection, a route handler for the OAuth callback, and a `/settings/mailboxes` page. Sync (reading mail) is M3, not here.

**Tech Stack:** As M1 (Node ≥ 22, TypeScript, pnpm 11 workspaces, Turborepo, Vitest 5, Next.js 16.4 with `cacheComponents`, Drizzle 0.45, Better Auth 1.7, Playwright) — no new third-party runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-replywise-design.md` — read §3 (MailProvider interface), §5 item 2 (mailbox connection), §6 (secrets), §8 (security risks). M1 plan for repo conventions: `docs/superpowers/plans/2026-11-15-m1-foundation.md`.

## Global Constraints

- Never request or store mailbox passwords; OAuth 2.0 Authorization Code + PKCE (S256) only.
- Gmail scopes: `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.compose`. Outlook scopes: `offline_access`, `User.Read`, `Mail.ReadWrite`. **`Mail.Send` is never requested. No code in `@replywise/mail` may call a send endpoint** (enforced by a test in Task 4).
- `state`: 32 random bytes, stored only as its SHA-256, single-use, bound to the signed-in user, 10-minute TTL.
- Verify all required scopes were granted at the callback; refuse the connection otherwise.
- Tokens are stored as encrypted JSON `{accessToken, refreshToken, expiresAt}` with AAD `aad.mailTokens(mailAccountId)`; code verifiers with AAD `aad.oauthVerifier(stateHash)`. Tokens never appear in logs, errors, URLs or job payloads.
- Refresh when `expiresAt − 5 min ≤ now`, serialized per mailbox. **Spec deviation (deliberate):** the lock is a Postgres row lock (`SELECT … FOR UPDATE`) instead of a Redis lock — same single-refresher guarantee, no Redis client needed in the web app.
- `invalid_grant` on refresh → mailbox status `needs_reauth`; UI shows Reconnect.
- Disconnect: revoke at the provider when supported (Google), delete the `mail_accounts` row (cascades), write `audit_logs`. Microsoft has no per-app revocation API; the UI tells the user where to remove access.
- Env names: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET` (all optional; a provider is enabled only when both of its values are set). These are separate from the app-login `GOOGLE_CLIENT_ID/SECRET`.
- Redirect URIs: `${APP_URL}/api/oauth/gmail/callback` and `${APP_URL}/api/oauth/outlook/callback`.
- Next.js 16 rules from M1 apply: session reads inside `<Suspense>`; `headers()` is read before env/DB is touched; `searchParams` are awaited inside `<Suspense>`.
- Docker CLI on this machine: `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"` (not on Git Bash PATH). Integration tests need `docker compose up -d --wait`.
- Commit after every task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map (M2)

```
packages/core/src/mail.ts                          (+ isMailProviderId)
packages/config/src/env.ts                         (+ GMAIL_*/OUTLOOK_* optional vars)
packages/mail/                                     NEW — provider OAuth adapters
  src/{index,types,pkce,scopes,http,gmail,outlook,registry}.ts
  src/{pkce,scopes,gmail,outlook,no-send}.test.ts
packages/db/src/client.ts                          (+ DbExecutor type)
packages/db/src/queries/{mailboxes,audit}.ts       NEW
packages/db/src/queries/mailboxes.int.test.ts      NEW
packages/mailbox/                                  NEW — domain services
  src/{index,deps,errors,tokens-codec,connect,access-token,disconnect,testing}.ts
  src/{connect,access-token,disconnect}.int.test.ts
packages/queue/src/jobs.ts                         (+ maintenance.purgeOAuthStates)
apps/worker/src/jobs/purge-oauth-states.ts         NEW
apps/worker/src/main.ts                            (+ schedule/handler)
apps/web/src/lib/{crypto,mailbox,mailbox-messages}.ts            NEW
apps/web/src/lib/mailbox-messages.test.ts                         NEW
apps/web/src/app/api/oauth/[provider]/callback/route.ts           NEW
apps/web/src/app/(app)/settings/mailboxes/{page,actions}.tsx|ts   NEW
apps/web/src/components/mailboxes/{mailbox-list,connect-buttons,disconnect-button,flash}.tsx NEW
apps/web/src/components/inbox/empty-inbox.tsx      (+ optional action)
apps/web/src/app/(app)/{inbox/page,settings/page}.tsx (links to mailboxes)
apps/web/e2e/mailboxes.spec.ts                     NEW
.env.example, README.md                            (credential setup)
```

---

### Task 1: Provider id guard and mailbox OAuth env vars

**Files:**
- Modify: `packages/core/src/mail.ts`, `packages/core/src/categories.test.ts` → add `packages/core/src/mail.test.ts`
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `isMailProviderId(value: string): value is MailProviderId` (core); `baseEnvSchema` gains optional `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET` (so both `WorkerEnv` and `WebEnv` have them).

- [ ] **Step 1: Write the failing tests**

`packages/core/src/mail.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isMailProviderId } from "./mail";

describe("isMailProviderId", () => {
  it("accepts the supported providers only", () => {
    expect(isMailProviderId("gmail")).toBe(true);
    expect(isMailProviderId("outlook")).toBe(true);
    expect(isMailProviderId("yahoo")).toBe(false);
    expect(isMailProviderId("GMAIL")).toBe(false);
    expect(isMailProviderId("")).toBe(false);
  });
});
```

Append to `packages/config/src/env.test.ts` (inside the existing `describe("parseEnv", …)` block):
```ts
  it("accepts optional mailbox OAuth credentials", () => {
    const env = parseEnv(workerEnvSchema, {
      ...base,
      GMAIL_CLIENT_ID: "gmail-id",
      GMAIL_CLIENT_SECRET: "gmail-secret",
      OUTLOOK_CLIENT_ID: "",
    });
    expect(env.GMAIL_CLIENT_ID).toBe("gmail-id");
    expect(env.GMAIL_CLIENT_SECRET).toBe("gmail-secret");
    expect(env.OUTLOOK_CLIENT_ID).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/core test && pnpm --filter @replywise/config test`
Expected: FAIL — `isMailProviderId` is not exported; `env.GMAIL_CLIENT_ID` is `undefined` (Zod strips unknown keys).

- [ ] **Step 3: Implement**

Append to `packages/core/src/mail.ts`:
```ts
export function isMailProviderId(value: string): value is MailProviderId {
  return (MAIL_PROVIDERS as readonly string[]).includes(value);
}
```

In `packages/config/src/env.ts`, add these keys to `baseEnvSchema`'s object (after `LOG_LEVEL`):
```ts
  GMAIL_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_CLIENT_SECRET: z.string().min(1).optional(),
  OUTLOOK_CLIENT_ID: z.string().min(1).optional(),
  OUTLOOK_CLIENT_SECRET: z.string().min(1).optional(),
```

Append to `turbo.json` → `globalPassThroughEnv`: `"GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "OUTLOOK_CLIENT_ID", "OUTLOOK_CLIENT_SECRET"`.

Append to `.env.example`:
```bash
# Mailbox connection (M2). Separate from GOOGLE_CLIENT_ID above, which is only for app login.
# Setup steps: README.md → "Connecting mailboxes in development".
# Redirect URI to register: http://localhost:3000/api/oauth/gmail/callback
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
# Redirect URI to register: http://localhost:3000/api/oauth/outlook/callback
OUTLOOK_CLIENT_ID=
OUTLOOK_CLIENT_SECRET=
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/core test && pnpm --filter @replywise/config test && pnpm typecheck`
Expected: core 5 tests PASS, config 6 tests PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(config): add mailbox OAuth env vars and provider id guard"
```

---

### Task 2: `@replywise/mail` — PKCE and scope helpers

**Files:**
- Create: `packages/mail/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts}`
- Create: `packages/mail/src/{index,types,pkce,scopes}.ts`
- Test: `packages/mail/src/pkce.test.ts`, `packages/mail/src/scopes.test.ts`

**Interfaces:**
- Produces (`types.ts`): `OAuthTokens {accessToken: string; refreshToken: string; expiresAt: string /* ISO */}`; `TokenGrant {tokens: OAuthTokens; grantedScopes: string[]}`; `MailboxProfile {email: string; displayName: string | null}`; `AuthorizationRequest {state; codeChallenge; redirectUri; loginHint?}`; `FetchLike = (url: string, init?: RequestInit) => Promise<Response>`; `MailOAuthProvider` (below).
- Produces (`pkce.ts`): `randomToken(bytes?: number): string` (base64url), `codeChallengeS256(verifier: string): string`, `hashState(state: string): string` (hex SHA-256).
- Produces (`scopes.ts`): `parseScopes(value: string | undefined): string[]`, `normalizeScope(scope: string): string`, `missingScopes(granted: readonly string[], required: readonly string[]): string[]`.

- [ ] **Step 1: Create the package**

`packages/mail/package.json`:
```json
{
  "name": "@replywise/mail",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "test:int": "vitest run -c vitest.int.config.ts --passWithNoTests"
  }
}
```
Copy `tsconfig.json`, `vitest.config.ts`, `vitest.int.config.ts` from `packages/crypto/`. Then:
```bash
pnpm --filter @replywise/mail add "@replywise/core@workspace:*"
pnpm --filter @replywise/mail add -D vitest typescript @types/node
```

`packages/mail/src/types.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing tests**

`packages/mail/src/pkce.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { codeChallengeS256, hashState, randomToken } from "./pkce";

describe("PKCE helpers", () => {
  it("matches the RFC 7636 Appendix B test vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates unpredictable URL-safe tokens of the requested strength", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(48)).toHaveLength(64);
  });

  it("hashes state to 64 hex chars without echoing it", () => {
    const hash = hashState("some-state");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashState("some-state"));
    expect(hash).not.toBe(hashState("other-state"));
  });
});
```

`packages/mail/src/scopes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { missingScopes, normalizeScope, parseScopes } from "./scopes";

describe("scopes", () => {
  it("parses space-separated scope strings", () => {
    expect(parseScopes("a  b\tc")).toEqual(["a", "b", "c"]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });

  it("normalizes Microsoft Graph resource prefixes and case", () => {
    expect(normalizeScope("https://graph.microsoft.com/Mail.ReadWrite")).toBe("mail.readwrite");
    expect(normalizeScope("User.Read")).toBe("user.read");
  });

  it("reports required scopes the user did not grant", () => {
    const required = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ];
    expect(missingScopes(["https://www.googleapis.com/auth/gmail.readonly"], required)).toEqual([
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    expect(missingScopes(required, required)).toEqual([]);
    expect(
      missingScopes(["https://graph.microsoft.com/User.Read", "mail.readwrite"], [
        "User.Read",
        "Mail.ReadWrite",
      ]),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @replywise/mail test`
Expected: FAIL — cannot resolve `./pkce` / `./scopes`.

- [ ] **Step 4: Implement**

`packages/mail/src/pkce.ts`:
```ts
import { createHash, randomBytes } from "node:crypto";

/** Cryptographically random, base64url-encoded token (32 bytes → 43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The raw OAuth state is never stored; only this hash is. */
export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
```

`packages/mail/src/scopes.ts`:
```ts
const GRAPH_PREFIX = /^https:\/\/graph\.microsoft\.com\//i;

export function parseScopes(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter(Boolean);
}

export function normalizeScope(scope: string): string {
  return scope.trim().replace(GRAPH_PREFIX, "").toLowerCase();
}

export function missingScopes(
  granted: readonly string[],
  required: readonly string[],
): string[] {
  const have = new Set(granted.map(normalizeScope));
  return required.filter((scope) => !have.has(normalizeScope(scope)));
}
```

`packages/mail/src/index.ts`:
```ts
export * from "./pkce";
export * from "./scopes";
export type * from "./types";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mail test && pnpm --filter @replywise/mail typecheck && pnpm lint`
Expected: 6 tests PASS; typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mail): add PKCE and scope helpers"
```

---

### Task 3: `@replywise/mail` — OAuth HTTP helpers and Gmail provider

**Files:**
- Create: `packages/mail/src/{http,gmail}.ts`
- Modify: `packages/mail/src/index.ts`
- Test: `packages/mail/src/gmail.test.ts`

**Interfaces:**
- Consumes: Task 2 types and helpers.
- Produces (`http.ts`): `class OAuthError extends Error { code: string; status: number }`; `class ProviderHttpError extends Error { status: number; endpoint: string }`; `postForm(fetchImpl, url, params): Promise<Record<string, unknown>>`; `getJson(fetchImpl, url, accessToken): Promise<Record<string, unknown>>`; `tokenGrantFrom(body, now, previous?): TokenGrant`.
- Produces (`gmail.ts`): `GMAIL_SCOPES`; `createGmailOAuth(config: { clientId: string; clientSecret: string; fetch?: FetchLike }): MailOAuthProvider`.

- [ ] **Step 1: Write the failing test**

`packages/mail/src/gmail.test.ts`:
```ts
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
      { status: 400, body: { error: "invalid_grant", error_description: "Token has been revoked." } },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @replywise/mail test`
Expected: FAIL — cannot resolve `./gmail` / `./http`.

- [ ] **Step 3: Implement**

`packages/mail/src/http.ts`:
```ts
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
  return {
    tokens: {
      accessToken,
      refreshToken,
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    },
    grantedScopes: parseScopes(typeof body.scope === "string" ? body.scope : undefined),
  };
}
```

`packages/mail/src/gmail.ts`:
```ts
import { getJson, postForm, ProviderHttpError, tokenGrantFrom } from "./http";
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
```

Replace `packages/mail/src/index.ts`:
```ts
export * from "./gmail";
export * from "./http";
export * from "./pkce";
export * from "./scopes";
export type * from "./types";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mail test && pnpm --filter @replywise/mail typecheck && pnpm lint`
Expected: 12 tests PASS; typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mail): add OAuth HTTP helpers and Gmail provider"
```

---

### Task 4: `@replywise/mail` — Outlook provider, registry and no-send guard

**Files:**
- Create: `packages/mail/src/{outlook,registry}.ts`
- Modify: `packages/mail/src/index.ts`
- Test: `packages/mail/src/outlook.test.ts`, `packages/mail/src/no-send.test.ts`

**Interfaces:**
- Produces: `OUTLOOK_SCOPES`; `createOutlookOAuth(config: { clientId; clientSecret; fetch? }): MailOAuthProvider`; `type MailOAuthProviders = Partial<Record<MailProviderId, MailOAuthProvider>>`; `createMailOAuthProviders(config: { gmail?: {clientId?: string; clientSecret?: string}; outlook?: {...}; fetch?: FetchLike }): MailOAuthProviders` (a provider is created only when both id and secret are non-empty).

- [ ] **Step 1: Write the failing tests**

`packages/mail/src/outlook.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { OAuthError } from "./http";
import { createOutlookOAuth, OUTLOOK_SCOPES } from "./outlook";
import { createMailOAuthProviders } from "./registry";
import type { FetchLike } from "./types";

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: URLSearchParams | null }> =
    [];
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
```

`packages/mail/src/no-send.test.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec §8: Replywise must never send email. Provider code may not reference send endpoints.
const FORBIDDEN = [
  /sendMail/i,
  /\/send\b/i,
  /messages\.send/i,
  /drafts\/send/i,
  /mail\.send/i,
];

describe("no-send guard", () => {
  it("finds no send endpoints or send scopes in provider source", () => {
    const dir = import.meta.dirname;
    const sources = (readdirSync(dir, { recursive: true }) as string[]).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(3);
    const offenders = sources.flatMap((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map((p) => `${file}: ${p}`);
    });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/mail test`
Expected: FAIL — cannot resolve `./outlook` / `./registry` (the no-send test passes already; that is expected).

- [ ] **Step 3: Implement**

`packages/mail/src/outlook.ts`:
```ts
import { getJson, postForm, ProviderHttpError, tokenGrantFrom } from "./http";
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
```

`packages/mail/src/registry.ts`:
```ts
import type { MailProviderId } from "@replywise/core";
import { createGmailOAuth } from "./gmail";
import { createOutlookOAuth } from "./outlook";
import type { FetchLike, MailOAuthProvider } from "./types";

export type MailOAuthProviders = Partial<Record<MailProviderId, MailOAuthProvider>>;

interface ClientCredentials {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
}

export interface MailOAuthConfig {
  gmail?: ClientCredentials;
  outlook?: ClientCredentials;
  fetch?: FetchLike;
}

function complete(c: ClientCredentials | undefined): { clientId: string; clientSecret: string } | null {
  return c?.clientId && c.clientSecret ? { clientId: c.clientId, clientSecret: c.clientSecret } : null;
}

/** Only providers with both a client id and a secret are enabled. */
export function createMailOAuthProviders(config: MailOAuthConfig): MailOAuthProviders {
  const providers: MailOAuthProviders = {};
  const fetchOption = config.fetch ? { fetch: config.fetch } : {};
  const gmail = complete(config.gmail);
  if (gmail) providers.gmail = createGmailOAuth({ ...gmail, ...fetchOption });
  const outlook = complete(config.outlook);
  if (outlook) providers.outlook = createOutlookOAuth({ ...outlook, ...fetchOption });
  return providers;
}
```

Replace `packages/mail/src/index.ts`:
```ts
export * from "./gmail";
export * from "./http";
export * from "./outlook";
export * from "./pkce";
export * from "./registry";
export * from "./scopes";
export type * from "./types";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mail test && pnpm --filter @replywise/mail typecheck && pnpm lint`
Expected: 18 tests PASS; typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mail): add Outlook provider, provider registry and no-send guard"
```

---

### Task 5: `@replywise/db` — mailbox, OAuth-state and audit queries

**Files:**
- Modify: `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Create: `packages/db/src/queries/{mailboxes,audit}.ts`
- Test: `packages/db/src/queries/mailboxes.int.test.ts`

**Interfaces:**
- Produces (`client.ts`): `type DbTransaction`, `type DbExecutor = Db | DbTransaction`.
- Produces (`mailboxes.ts`): `type MailAccount = typeof mailAccounts.$inferSelect`; `type MailAccountSummary` (no ciphertext); `listMailAccounts(db, userId): Promise<MailAccountSummary[]>`; `getMailAccountForUser(db, userId, id): Promise<MailAccount | null>`; `deleteMailAccountForUser(db, userId, id): Promise<boolean>`; `insertOAuthState(db, values: typeof mailOAuthStates.$inferInsert): Promise<void>`; `consumeOAuthState(db, stateHash): Promise<typeof mailOAuthStates.$inferSelect | null>` (deletes the row — single use); `purgeExpiredOAuthStates(db, now?): Promise<number>`.
- Produces (`audit.ts`): `type AuditAction = "mailbox.connected" | "mailbox.reconnected" | "mailbox.disconnected" | "mailbox.reauth_required"`; `insertAuditLog(db, entry: {userId; action: AuditAction; targetType?; targetId?; ip?; userAgent?; metadata?}): Promise<void>`.

- [ ] **Step 1: Write the failing integration test**

`packages/db/src/queries/mailboxes.int.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { auditLogs, mailOAuthStates } from "../schema/index";
import { insertMailAccount, insertThread, insertUser, resetTestDb, setupTestDb } from "../testing";
import { insertAuditLog } from "./audit";
import {
  consumeOAuthState,
  deleteMailAccountForUser,
  getMailAccountForUser,
  insertOAuthState,
  listMailAccounts,
  purgeExpiredOAuthStates,
} from "./mailboxes";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("mailbox queries are scoped to their owner", () => {
  it("lists only the user's mailboxes and never returns token ciphertext", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    await insertMailAccount(db, alice.id, { emailAddress: "alice@gmail.com" });
    await insertMailAccount(db, bob.id, { emailAddress: "bob@gmail.com" });

    const list = await listMailAccounts(db, alice.id);
    expect(list.map((a) => a.emailAddress)).toEqual(["alice@gmail.com"]);
    expect(list[0]).not.toHaveProperty("tokensCiphertext");
  });

  it("does not let one user read or delete another user's mailbox", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const account = await insertMailAccount(db, alice.id);
    await insertThread(db, account.id);

    expect(await getMailAccountForUser(db, bob.id, account.id)).toBeNull();
    expect(await deleteMailAccountForUser(db, bob.id, account.id)).toBe(false);
    expect(await getMailAccountForUser(db, alice.id, account.id)).not.toBeNull();

    expect(await deleteMailAccountForUser(db, alice.id, account.id)).toBe(true);
    expect(await getMailAccountForUser(db, alice.id, account.id)).toBeNull();
  });
});

describe("OAuth states", () => {
  it("can be consumed exactly once", async () => {
    const user = await insertUser(db);
    await insertOAuthState(db, {
      stateHash: "h1",
      userId: user.id,
      provider: "gmail",
      codeVerifierCiphertext: Buffer.from("v"),
      returnTo: "/settings/mailboxes",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await consumeOAuthState(db, "h1"))?.userId).toBe(user.id);
    expect(await consumeOAuthState(db, "h1")).toBeNull();
    expect(await consumeOAuthState(db, "never-issued")).toBeNull();
  });

  it("purges only expired states", async () => {
    const user = await insertUser(db);
    const now = new Date("2026-11-16T12:00:00Z");
    for (const [hash, expiresAt] of [
      ["old", new Date("2026-11-16T11:59:00Z")],
      ["fresh", new Date("2026-11-16T12:05:00Z")],
    ] as const) {
      await insertOAuthState(db, {
        stateHash: hash,
        userId: user.id,
        provider: "outlook",
        codeVerifierCiphertext: Buffer.from("v"),
        returnTo: "/settings/mailboxes",
        expiresAt,
      });
    }
    expect(await purgeExpiredOAuthStates(db, now)).toBe(1);
    expect((await db.select().from(mailOAuthStates)).map((s) => s.stateHash)).toEqual(["fresh"]);
  });
});

describe("insertAuditLog", () => {
  it("records the action with context", async () => {
    const user = await insertUser(db);
    await insertAuditLog(db, {
      userId: user.id,
      action: "mailbox.connected",
      targetType: "mail_account",
      targetId: "acc-1",
      ip: "203.0.113.7",
      userAgent: "test-agent",
      metadata: { provider: "gmail" },
    });
    const [row] = await db.select().from(auditLogs);
    expect(row).toMatchObject({
      action: "mailbox.connected",
      targetId: "acc-1",
      ip: "203.0.113.7",
      metadata: { provider: "gmail" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `"/c/Program Files/Docker/Docker/resources/bin/docker.exe" compose up -d --wait && pnpm --filter @replywise/db test:int`
Expected: FAIL — cannot resolve `./audit` / `./mailboxes`.

- [ ] **Step 3: Implement**

Append to `packages/db/src/client.ts`:
```ts
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Query functions accept either the pool or an open transaction. */
export type DbExecutor = Db | DbTransaction;
```

`packages/db/src/queries/mailboxes.ts`:
```ts
import { and, eq, lte } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { mailAccounts, mailOAuthStates } from "../schema/mail";

export type MailAccount = typeof mailAccounts.$inferSelect;

const summaryColumns = {
  id: mailAccounts.id,
  provider: mailAccounts.provider,
  emailAddress: mailAccounts.emailAddress,
  displayName: mailAccounts.displayName,
  status: mailAccounts.status,
  lastSyncedAt: mailAccounts.lastSyncedAt,
  lastError: mailAccounts.lastError,
  createdAt: mailAccounts.createdAt,
};

export type MailAccountSummary = {
  [K in keyof typeof summaryColumns]: MailAccount[K];
};

/** Safe for the UI: never includes token ciphertext. */
export async function listMailAccounts(
  db: DbExecutor,
  userId: string,
): Promise<MailAccountSummary[]> {
  return db
    .select(summaryColumns)
    .from(mailAccounts)
    .where(eq(mailAccounts.userId, userId))
    .orderBy(mailAccounts.createdAt);
}

export async function getMailAccountForUser(
  db: DbExecutor,
  userId: string,
  id: string,
): Promise<MailAccount | null> {
  const [row] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)));
  return row ?? null;
}

export async function deleteMailAccountForUser(
  db: DbExecutor,
  userId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)))
    .returning({ id: mailAccounts.id });
  return deleted.length > 0;
}

export async function insertOAuthState(
  db: DbExecutor,
  values: typeof mailOAuthStates.$inferInsert,
): Promise<void> {
  await db.insert(mailOAuthStates).values(values);
}

/** Deletes and returns the state row: a state can only ever be used once. */
export async function consumeOAuthState(
  db: DbExecutor,
  stateHash: string,
): Promise<typeof mailOAuthStates.$inferSelect | null> {
  const [row] = await db
    .delete(mailOAuthStates)
    .where(eq(mailOAuthStates.stateHash, stateHash))
    .returning();
  return row ?? null;
}

export async function purgeExpiredOAuthStates(
  db: DbExecutor,
  now: Date = new Date(),
): Promise<number> {
  const purged = await db
    .delete(mailOAuthStates)
    .where(lte(mailOAuthStates.expiresAt, now))
    .returning({ stateHash: mailOAuthStates.stateHash });
  return purged.length;
}
```

`packages/db/src/queries/audit.ts`:
```ts
import type { DbExecutor } from "../client";
import { auditLogs } from "../schema/audit";

export type AuditAction =
  | "mailbox.connected"
  | "mailbox.reconnected"
  | "mailbox.disconnected"
  | "mailbox.reauth_required";

export interface AuditEntry {
  userId: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Never put email content or secrets here. */
  metadata?: Record<string, unknown>;
}

export async function insertAuditLog(db: DbExecutor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    userId: entry.userId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    metadata: entry.metadata ?? {},
  });
}
```

Replace `packages/db/src/index.ts`:
```ts
export * from "./client";
export * from "./queries/audit";
export * from "./queries/mailboxes";
export * from "./queries/maintenance";
export * from "./schema/index";
// Migrations live at "@replywise/db/migrate" so app bundles never pull in the runner.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/db test:int && pnpm --filter @replywise/db typecheck && pnpm lint`
Expected: 12 integration tests PASS (7 existing + 5 new); typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): add owner-scoped mailbox, OAuth state and audit queries"
```

---

### Task 6: `@replywise/mailbox` — start and complete a connection

**Files:**
- Create: `packages/mailbox/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts}`
- Create: `packages/mailbox/src/{index,deps,errors,tokens-codec,connect,testing}.ts`
- Test: `packages/mailbox/src/connect.int.test.ts`

**Interfaces:**
- Consumes: `MailOAuthProvider`, `MailOAuthProviders`, `OAuthTokens`, `randomToken`, `codeChallengeS256`, `hashState`, `missingScopes`, `OAuthError` (mail); `Db`, `mailAccounts`, `insertOAuthState`, `consumeOAuthState`, `insertAuditLog` (db); `Encryptor`, `aad` (crypto).
- Produces (`deps.ts`): `interface MailboxDeps { db: Db; encryptor: Encryptor; providers: MailOAuthProviders; now?: () => Date }`; `interface RequestContext { ip?: string | null; userAgent?: string | null }`.
- Produces (`errors.ts`): `type ConnectFailure = "not_configured" | "invalid_state" | "expired_state" | "provider_mismatch" | "access_denied" | "missing_scopes" | "provider_error"`; `class ConnectError { reason: ConnectFailure }`; `class ReauthRequiredError { mailAccountId }`; `class MailAccountNotFoundError { mailAccountId }`.
- Produces (`tokens-codec.ts`): `encryptTokens(encryptor, mailAccountId, tokens): Promise<Buffer>`, `decryptTokens(encryptor, mailAccountId, blob): Promise<OAuthTokens>`.
- Produces (`connect.ts`): `MAILBOXES_PATH = "/settings/mailboxes"`; `OAUTH_STATE_TTL_MS`; `startConnect(deps, { userId; provider; redirectUri; loginHint? }): Promise<string>` (authorization URL); `completeConnect(deps, { userId; provider; code; state; redirectUri; context? }): Promise<{ mailAccountId: string; emailAddress: string; reconnected: boolean }>`.
- Produces (`testing.ts`, exported as `@replywise/mailbox/testing`): `createFakeProvider(id?, options?)` → `{ provider: MailOAuthProvider; calls }`; `testEncryptor()`.

- [ ] **Step 1: Create the package**

`packages/mailbox/package.json`:
```json
{
  "name": "@replywise/mailbox",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "test:int": "vitest run -c vitest.int.config.ts"
  }
}
```
Copy `tsconfig.json`, `vitest.config.ts`, `vitest.int.config.ts` from `packages/db/`. Then:
```bash
pnpm --filter @replywise/mailbox add "@replywise/core@workspace:*" "@replywise/crypto@workspace:*" "@replywise/db@workspace:*" "@replywise/mail@workspace:*" drizzle-orm
pnpm --filter @replywise/mailbox add -D vitest typescript @types/node
```

`packages/mailbox/src/deps.ts`:
```ts
import type { Encryptor } from "@replywise/crypto";
import type { Db } from "@replywise/db";
import type { MailOAuthProviders } from "@replywise/mail";

export interface MailboxDeps {
  db: Db;
  encryptor: Encryptor;
  providers: MailOAuthProviders;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

export function clock(deps: MailboxDeps): Date {
  return deps.now?.() ?? new Date();
}
```

`packages/mailbox/src/errors.ts`:
```ts
export type ConnectFailure =
  | "not_configured"
  | "invalid_state"
  | "expired_state"
  | "provider_mismatch"
  | "access_denied"
  | "missing_scopes"
  | "provider_error";

export class ConnectError extends Error {
  constructor(
    readonly reason: ConnectFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ConnectError";
  }
}

export class ReauthRequiredError extends Error {
  constructor(readonly mailAccountId: string) {
    super(`Mailbox ${mailAccountId} must be reconnected`);
    this.name = "ReauthRequiredError";
  }
}

export class MailAccountNotFoundError extends Error {
  constructor(readonly mailAccountId: string) {
    super(`Mailbox ${mailAccountId} not found`);
    this.name = "MailAccountNotFoundError";
  }
}
```

`packages/mailbox/src/tokens-codec.ts`:
```ts
import { aad, type Encryptor } from "@replywise/crypto";
import type { OAuthTokens } from "@replywise/mail";

export function encryptTokens(
  encryptor: Encryptor,
  mailAccountId: string,
  tokens: OAuthTokens,
): Promise<Buffer> {
  return encryptor.encrypt(JSON.stringify(tokens), aad.mailTokens(mailAccountId));
}

export async function decryptTokens(
  encryptor: Encryptor,
  mailAccountId: string,
  blob: Buffer,
): Promise<OAuthTokens> {
  const parsed: unknown = JSON.parse(
    await encryptor.decryptString(blob, aad.mailTokens(mailAccountId)),
  );
  const t = parsed as Partial<OAuthTokens>;
  if (typeof t.accessToken !== "string" || typeof t.refreshToken !== "string" || typeof t.expiresAt !== "string") {
    throw new Error("Stored mailbox tokens are malformed");
  }
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
}
```

`packages/mailbox/src/testing.ts`:
```ts
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

export function createFakeProvider(id: MailProviderId = "gmail", options: FakeProviderOptions = {}) {
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
```

- [ ] **Step 2: Write the failing integration test**

`packages/mailbox/src/connect.int.test.ts`:
```ts
import { auditLogs, type Db, mailAccounts, mailOAuthStates } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { codeChallengeS256 } from "@replywise/mail";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { completeConnect, MAILBOXES_PATH, startConnect } from "./connect";
import type { MailboxDeps } from "./deps";
import { ConnectError } from "./errors";
import { createFakeProvider, testEncryptor } from "./testing";
import { decryptTokens } from "./tokens-codec";

const REDIRECT = "http://localhost:3000/api/oauth/gmail/callback";
const T0 = new Date("2026-11-16T12:00:00Z");

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

function deps(fake = createFakeProvider("gmail"), now = T0): MailboxDeps {
  return { db, encryptor: testEncryptor(), providers: { gmail: fake.provider }, now: () => now };
}

async function begin(d: MailboxDeps, userId: string) {
  const url = await startConnect(d, { userId, provider: "gmail", redirectUri: REDIRECT });
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("no state in authorization URL");
  return state;
}

const reason = (r: ConnectError["reason"]) => (e: unknown) =>
  e instanceof ConnectError && e.reason === r;

describe("startConnect", () => {
  it("stores only a hash of the state and an encrypted PKCE verifier", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail");
    const state = await begin(deps(fake), user.id);

    const [row] = await db.select().from(mailOAuthStates);
    expect(row?.stateHash).not.toBe(state);
    expect(row?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.returnTo).toBe(MAILBOXES_PATH);
    expect(row?.expiresAt.getTime()).toBe(T0.getTime() + 10 * 60_000);
    expect(row?.codeVerifierCiphertext.includes(Buffer.from(fake.calls.lastCodeVerifier))).toBe(false);
  });

  it("refuses providers that are not configured", async () => {
    const user = await insertUser(db);
    const d: MailboxDeps = { ...deps(), providers: {} };
    await expect(
      startConnect(d, { userId: user.id, provider: "gmail", redirectUri: REDIRECT }),
    ).rejects.toSatisfy(reason("not_configured"));
  });
});

describe("completeConnect", () => {
  it("connects a mailbox with encrypted tokens, PKCE verified, and audits it", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail", { email: "me@gmail.com" });
    const d = deps(fake);
    const state = await begin(d, user.id);

    const result = await completeConnect(d, {
      userId: user.id,
      provider: "gmail",
      code: "good-code",
      state,
      redirectUri: REDIRECT,
      context: { ip: "203.0.113.9", userAgent: "vitest" },
    });

    expect(result).toMatchObject({ emailAddress: "me@gmail.com", reconnected: false });
    expect(codeChallengeS256(fake.calls.lastCodeVerifier)).toBe(
      fake.calls.lastAuthorization?.codeChallenge,
    );
    const [account] = await db.select().from(mailAccounts);
    expect(account?.id).toBe(result.mailAccountId);
    expect(account?.status).toBe("active");
    expect(account?.grantedScopes).toEqual(["scope.read", "scope.compose"]);
    expect(account?.tokensCiphertext.includes(Buffer.from("access-1"))).toBe(false);
    const tokens = await decryptTokens(d.encryptor, result.mailAccountId, account!.tokensCiphertext);
    expect(tokens.accessToken).toBe("access-1");

    const [audit] = await db.select().from(auditLogs);
    expect(audit).toMatchObject({
      action: "mailbox.connected",
      targetId: result.mailAccountId,
      ip: "203.0.113.9",
      metadata: { provider: "gmail" },
    });
    expect(await db.select().from(mailOAuthStates)).toHaveLength(0);
  });

  it("rejects a state that was already used", async () => {
    const user = await insertUser(db);
    const d = deps();
    const state = await begin(d, user.id);
    const input = { userId: user.id, provider: "gmail" as const, code: "c", state, redirectUri: REDIRECT };
    await completeConnect(d, input);
    await expect(completeConnect(d, input)).rejects.toSatisfy(reason("invalid_state"));
  });

  it("rejects a state issued to a different user", async () => {
    const alice = await insertUser(db);
    const mallory = await insertUser(db);
    const d = deps();
    const state = await begin(d, alice.id);
    await expect(
      completeConnect(d, { userId: mallory.id, provider: "gmail", code: "c", state, redirectUri: REDIRECT }),
    ).rejects.toSatisfy(reason("invalid_state"));
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("rejects an expired state", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail");
    const state = await begin(deps(fake, T0), user.id);
    const later = deps(fake, new Date(T0.getTime() + 11 * 60_000));
    await expect(
      completeConnect(later, { userId: user.id, provider: "gmail", code: "c", state, redirectUri: REDIRECT }),
    ).rejects.toSatisfy(reason("expired_state"));
  });

  it("rejects a state replayed against another provider", async () => {
    const user = await insertUser(db);
    const gmail = createFakeProvider("gmail");
    const outlook = createFakeProvider("outlook");
    const d: MailboxDeps = { ...deps(gmail), providers: { gmail: gmail.provider, outlook: outlook.provider } };
    const state = await begin(d, user.id);
    await expect(
      completeConnect(d, { userId: user.id, provider: "outlook", code: "c", state, redirectUri: REDIRECT }),
    ).rejects.toSatisfy(reason("provider_mismatch"));
  });

  it("refuses the connection when required scopes were not granted", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail", { grantedScopes: ["scope.read"] });
    const d = deps(fake);
    const state = await begin(d, user.id);
    await expect(
      completeConnect(d, { userId: user.id, provider: "gmail", code: "c", state, redirectUri: REDIRECT }),
    ).rejects.toSatisfy(reason("missing_scopes"));
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
    expect(fake.calls.revoke).toBe(1);
  });

  it("maps a failed code exchange to provider_error", async () => {
    const user = await insertUser(db);
    const d = deps();
    const state = await begin(d, user.id);
    await expect(
      completeConnect(d, { userId: user.id, provider: "gmail", code: "bad-code", state, redirectUri: REDIRECT }),
    ).rejects.toSatisfy(reason("provider_error"));
  });

  it("reconnecting the same mailbox keeps its id and restores active status", async () => {
    const user = await insertUser(db);
    const fake = createFakeProvider("gmail", { email: "me@gmail.com" });
    const d = deps(fake);
    const first = await completeConnect(d, {
      userId: user.id, provider: "gmail", code: "c", state: await begin(d, user.id), redirectUri: REDIRECT,
    });
    await db
      .update(mailAccounts)
      .set({ status: "needs_reauth", lastError: "revoked" })
      .where(eq(mailAccounts.id, first.mailAccountId));

    const second = await completeConnect(d, {
      userId: user.id, provider: "gmail", code: "c", state: await begin(d, user.id), redirectUri: REDIRECT,
    });
    expect(second).toMatchObject({ mailAccountId: first.mailAccountId, reconnected: true });
    const [account] = await db.select().from(mailAccounts);
    expect(account).toMatchObject({ status: "active", lastError: null });
    const tokens = await decryptTokens(d.encryptor, first.mailAccountId, account!.tokensCiphertext);
    expect(tokens.accessToken).toBe("access-2");
    const actions = (await db.select().from(auditLogs)).map((a) => a.action).sort();
    expect(actions).toEqual(["mailbox.connected", "mailbox.reconnected"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @replywise/mailbox test:int`
Expected: FAIL — cannot resolve `./connect`.

- [ ] **Step 4: Implement**

`packages/mailbox/src/connect.ts`:
```ts
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
    codeVerifierCiphertext: await deps.encryptor.encrypt(codeVerifier, aad.oauthVerifier(stateHash)),
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
```

`packages/mailbox/src/index.ts`:
```ts
export * from "./connect";
export * from "./deps";
export * from "./errors";
export * from "./tokens-codec";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mailbox test:int && pnpm --filter @replywise/mailbox typecheck && pnpm format && pnpm lint`
Expected: 10 tests PASS; typecheck and lint exit 0. (If lint flags the `account!` non-null assertions in the test, replace them with `if (!account) throw new Error("no account");` guards.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mailbox): add OAuth connect flow with single-use state, PKCE and audit"
```

---

### Task 7: `@replywise/mailbox` — valid access tokens and disconnect

**Files:**
- Create: `packages/mailbox/src/{access-token,disconnect}.ts`
- Modify: `packages/mailbox/src/index.ts`
- Test: `packages/mailbox/src/access-token.int.test.ts`, `packages/mailbox/src/disconnect.int.test.ts`

**Interfaces:**
- Consumes: Task 6 (`MailboxDeps`, errors, `encryptTokens`, `decryptTokens`, `createFakeProvider`, `testEncryptor`), `OAuthError` (mail), `getMailAccountForUser`, `deleteMailAccountForUser`, `insertAuditLog` (db).
- Produces: `REFRESH_SKEW_MS = 5 * 60 * 1000`; `getValidAccessToken(deps, mailAccountId): Promise<{ accessToken: string; provider: MailProviderId }>` (throws `ReauthRequiredError`, `MailAccountNotFoundError`); `disconnectMailbox(deps, { userId; mailAccountId; context? }): Promise<{ provider: MailProviderId; revoked: boolean }>` (throws `MailAccountNotFoundError`).

- [ ] **Step 1: Write the failing integration tests**

`packages/mailbox/src/access-token.int.test.ts`:
```ts
import { auditLogs, type Db, mailAccounts } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getValidAccessToken } from "./access-token";
import { completeConnect, startConnect } from "./connect";
import type { MailboxDeps } from "./deps";
import { ReauthRequiredError } from "./errors";
import { createFakeProvider, type FakeProviderOptions, testEncryptor } from "./testing";

const T0 = new Date("2026-11-16T12:00:00Z");
const MIN = 60_000;

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

/** Connects a mailbox at T0 with 60-minute tokens; returns deps factory bound to a clock. */
async function connected(options: FakeProviderOptions = {}) {
  const fake = createFakeProvider("gmail", options);
  const encryptor = testEncryptor();
  const at = (now: Date): MailboxDeps => ({ db, encryptor, providers: { gmail: fake.provider }, now: () => now });
  const user = await insertUser(db);
  const url = await startConnect(at(T0), { userId: user.id, provider: "gmail", redirectUri: "http://cb" });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(at(T0), {
    userId: user.id, provider: "gmail", code: "c", state, redirectUri: "http://cb",
  });
  return { fake, at, mailAccountId, userId: user.id };
}

describe("getValidAccessToken", () => {
  it("returns the stored token while it is fresh", async () => {
    const { fake, at, mailAccountId } = await connected();
    const result = await getValidAccessToken(at(new Date(T0.getTime() + 30 * MIN)), mailAccountId);
    expect(result).toEqual({ accessToken: "access-1", provider: "gmail" });
    expect(fake.calls.refresh).toBe(0);
  });

  it("refreshes within 5 minutes of expiry and stores the new tokens", async () => {
    const { fake, at, mailAccountId } = await connected();
    const nearExpiry = at(new Date(T0.getTime() + 56 * MIN));
    expect((await getValidAccessToken(nearExpiry, mailAccountId)).accessToken).toBe("access-2");
    expect((await getValidAccessToken(nearExpiry, mailAccountId)).accessToken).toBe("access-2");
    expect(fake.calls.refresh).toBe(1);
  });

  it("serializes concurrent refreshes with a row lock", async () => {
    const { fake, at, mailAccountId } = await connected({ refreshDelayMs: 150 });
    const nearExpiry = at(new Date(T0.getTime() + 58 * MIN));
    const [a, b] = await Promise.all([
      getValidAccessToken(nearExpiry, mailAccountId),
      getValidAccessToken(nearExpiry, mailAccountId),
    ]);
    expect(fake.calls.refresh).toBe(1);
    expect(a.accessToken).toBe("access-2");
    expect(b.accessToken).toBe("access-2");
  });

  it("marks the mailbox as needing reauth when the refresh token is revoked", async () => {
    const { fake, at, mailAccountId, userId } = await connected({ refreshError: "invalid_grant" });
    const later = at(new Date(T0.getTime() + 2 * 60 * MIN));
    await expect(getValidAccessToken(later, mailAccountId)).rejects.toBeInstanceOf(ReauthRequiredError);

    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
    expect(account?.status).toBe("needs_reauth");
    expect(account?.lastError).toMatch(/reconnect/i);
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.userId, userId))).map((a) => a.action);
    expect(actions).toContain("mailbox.reauth_required");

    await expect(getValidAccessToken(later, mailAccountId)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(fake.calls.refresh).toBe(1);
  });
});
```

`packages/mailbox/src/disconnect.int.test.ts`:
```ts
import { auditLogs, type Db, mailAccounts, threads } from "@replywise/db";
import { insertThread, insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { completeConnect, startConnect } from "./connect";
import type { MailboxDeps } from "./deps";
import { disconnectMailbox } from "./disconnect";
import { MailAccountNotFoundError } from "./errors";
import { createFakeProvider, testEncryptor } from "./testing";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function connect(provider: "gmail" | "outlook", supportsRevocation: boolean) {
  const fake = createFakeProvider(provider, { supportsRevocation });
  const d: MailboxDeps = { db, encryptor: testEncryptor(), providers: { [provider]: fake.provider } };
  const user = await insertUser(db);
  const url = await startConnect(d, { userId: user.id, provider, redirectUri: "http://cb" });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(d, {
    userId: user.id, provider, code: "c", state, redirectUri: "http://cb",
  });
  return { fake, d, userId: user.id, mailAccountId };
}

describe("disconnectMailbox", () => {
  it("revokes at the provider, deletes the mailbox with its data, and audits", async () => {
    const { fake, d, userId, mailAccountId } = await connect("gmail", true);
    await insertThread(db, mailAccountId);

    const result = await disconnectMailbox(d, { userId, mailAccountId, context: { ip: "198.51.100.4" } });

    expect(result).toEqual({ provider: "gmail", revoked: true });
    expect(fake.calls.revoke).toBe(1);
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
    expect(await db.select().from(threads)).toHaveLength(0);
    const actions = (await db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toContain("mailbox.disconnected");
  });

  it("reports revoked=false for providers without a revocation API", async () => {
    const { d, userId, mailAccountId } = await connect("outlook", false);
    expect(await disconnectMailbox(d, { userId, mailAccountId })).toEqual({
      provider: "outlook",
      revoked: false,
    });
  });

  it("still disconnects when revocation fails", async () => {
    const { fake, d, userId, mailAccountId } = await connect("gmail", true);
    fake.provider.revoke = async () => {
      throw new Error("network down");
    };
    expect(await disconnectMailbox(d, { userId, mailAccountId })).toEqual({
      provider: "gmail",
      revoked: false,
    });
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("refuses to disconnect another user's mailbox", async () => {
    const { d, mailAccountId } = await connect("gmail", true);
    const mallory = await insertUser(db);
    await expect(
      disconnectMailbox(d, { userId: mallory.id, mailAccountId }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
    expect(await db.select().from(mailAccounts)).toHaveLength(1);
  });
});
```

Note: `fake.provider.revoke = …` requires `MailOAuthProvider` methods to be assignable; the fake returns a plain object literal, so this works.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/mailbox test:int`
Expected: FAIL — cannot resolve `./access-token` / `./disconnect`.

- [ ] **Step 3: Implement**

`packages/mailbox/src/access-token.ts`:
```ts
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
          grantedScopes: grant.grantedScopes.length > 0 ? grant.grantedScopes : account.grantedScopes,
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
```

`packages/mailbox/src/disconnect.ts`:
```ts
import type { MailProviderId } from "@replywise/core";
import { deleteMailAccountForUser, getMailAccountForUser, insertAuditLog } from "@replywise/db";
import type { MailboxDeps, RequestContext } from "./deps";
import { MailAccountNotFoundError } from "./errors";
import { decryptTokens } from "./tokens-codec";

/**
 * Revokes provider access when supported (best effort), then deletes the mailbox and all
 * of its synced data (FK cascade), and audits the change.
 */
export async function disconnectMailbox(
  deps: MailboxDeps,
  input: { userId: string; mailAccountId: string; context?: RequestContext },
): Promise<{ provider: MailProviderId; revoked: boolean }> {
  const account = await getMailAccountForUser(deps.db, input.userId, input.mailAccountId);
  if (!account) throw new MailAccountNotFoundError(input.mailAccountId);

  let revoked = false;
  const provider = deps.providers[account.provider];
  if (provider?.supportsRevocation) {
    try {
      await provider.revoke(await decryptTokens(deps.encryptor, account.id, account.tokensCiphertext));
      revoked = true;
    } catch {
      revoked = false;
    }
  }

  await deps.db.transaction(async (tx) => {
    const deleted = await deleteMailAccountForUser(tx, input.userId, account.id);
    if (!deleted) throw new MailAccountNotFoundError(account.id);
    await insertAuditLog(tx, {
      userId: input.userId,
      action: "mailbox.disconnected",
      targetType: "mail_account",
      targetId: account.id,
      ip: input.context?.ip ?? null,
      userAgent: input.context?.userAgent ?? null,
      metadata: { provider: account.provider, revoked },
    });
  });

  return { provider: account.provider, revoked };
}
```

Replace `packages/mailbox/src/index.ts`:
```ts
export * from "./access-token";
export * from "./connect";
export * from "./deps";
export * from "./disconnect";
export * from "./errors";
export * from "./tokens-codec";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mailbox test:int && pnpm --filter @replywise/mailbox typecheck && pnpm format && pnpm lint`
Expected: 18 tests PASS (10 + 4 + 4); typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mailbox): add locked token refresh and mailbox disconnect"
```

---

### Task 8: Worker — purge expired OAuth states

**Files:**
- Modify: `packages/queue/src/jobs.ts`
- Create: `apps/worker/src/jobs/purge-oauth-states.ts`
- Modify: `apps/worker/src/main.ts`, `apps/worker/src/main.int.test.ts`

**Interfaces:**
- Consumes: `purgeExpiredOAuthStates(db, now)` (Task 5).
- Produces: job `"maintenance.purgeOAuthStates"` (queue `maintenance`, payload `{}`); `PURGE_OAUTH_STATES_SCHEDULER_ID = "maintenance.purgeOAuthStates:hourly"`; `purgeOAuthStatesHandler(deps: { db; logger; now? })`.

- [ ] **Step 1: Write the failing tests**

In `apps/worker/src/main.int.test.ts`, add imports `mailOAuthStates` (from `@replywise/db`) and `purgeOAuthStatesHandler` (from `./jobs/purge-oauth-states`), import `PURGE_OAUTH_STATES_SCHEDULER_ID` alongside `PURGE_BODIES_SCHEDULER_ID`, and add:
```ts
describe("purgeOAuthStatesHandler", () => {
  it("removes expired OAuth states and logs only the count", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    await db.insert(mailOAuthStates).values({
      stateHash: "expired",
      userId: user.id,
      provider: "gmail",
      codeVerifierCiphertext: Buffer.from("v"),
      returnTo: "/settings/mailboxes",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    const { logger, lines } = silentLogger();

    await purgeOAuthStatesHandler({ db, logger, now: () => new Date("2026-11-16T00:00:00Z") })();

    expect(await db.select().from(mailOAuthStates)).toHaveLength(0);
    expect(lines.join("")).toContain('"purged":1');
  });
});
```
and in the existing `startWorker` test change the scheduler assertion to:
```ts
      const ids = schedulers.map((s) => s.key);
      expect(ids).toContain(PURGE_BODIES_SCHEDULER_ID);
      expect(ids).toContain(PURGE_OAUTH_STATES_SCHEDULER_ID);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/worker test:int`
Expected: FAIL — cannot resolve `./jobs/purge-oauth-states`.

- [ ] **Step 3: Implement**

In `packages/queue/src/jobs.ts`, extend `jobDefinitions`:
```ts
export const jobDefinitions = {
  "maintenance.purgeBodies": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.purgeOAuthStates": { queue: "maintenance", payload: z.object({}).strict() },
} as const satisfies Record<string, { queue: QueueName; payload: z.ZodType }>;
```

`apps/worker/src/jobs/purge-oauth-states.ts`:
```ts
import { type Db, purgeExpiredOAuthStates } from "@replywise/db";
import type { Logger } from "@replywise/observability";

export function purgeOAuthStatesHandler(deps: { db: Db; logger: Logger; now?: () => Date }) {
  return async (): Promise<void> => {
    const purged = await purgeExpiredOAuthStates(deps.db, deps.now?.() ?? new Date());
    deps.logger.info({ purged }, "purged expired OAuth states");
  };
}
```

In `apps/worker/src/main.ts`:
- import `purgeOAuthStatesHandler` from `./jobs/purge-oauth-states`;
- add `export const PURGE_OAUTH_STATES_SCHEDULER_ID = "maintenance.purgeOAuthStates:hourly";`;
- add `"maintenance.purgeOAuthStates": purgeOAuthStatesHandler({ db, logger }),` to the handlers object passed to `createJobWorker`;
- after the existing `scheduleRepeating(...)` call add:
```ts
  await queue.scheduleRepeating(
    PURGE_OAUTH_STATES_SCHEDULER_ID,
    "maintenance.purgeOAuthStates",
    {},
    ONE_HOUR_MS,
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/queue test:int && pnpm --filter @replywise/worker test:int && pnpm typecheck && pnpm lint`
Expected: queue 5 PASS, worker 3 PASS; typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): purge expired OAuth states hourly"
```

---

### Task 9: Web — OAuth callback, Server Actions and flash messages

**Files:**
- Modify: `apps/web/package.json`, `apps/web/next.config.ts`
- Create: `apps/web/src/lib/{crypto,mailbox,mailbox-messages}.ts`
- Create: `apps/web/src/app/api/oauth/[provider]/callback/route.ts`
- Create: `apps/web/src/app/(app)/settings/mailboxes/actions.ts`
- Test: `apps/web/src/lib/mailbox-messages.test.ts`

**Interfaces:**
- Consumes: `startConnect`, `completeConnect`, `disconnectMailbox`, `ConnectError`, `MailAccountNotFoundError`, `MAILBOXES_PATH`, `MailboxDeps` (mailbox); `createMailOAuthProviders` (mail); `createEncryptor`, `LocalKeyProvider` (crypto); `isMailProviderId`, `MailProviderId` (core); `getSession`, `requireUser` (web `lib/auth`); `getDb` (web `lib/db`); `getEnv` (web `lib/env`).
- Produces: `getEncryptor(): Encryptor`; `getMailboxDeps(): MailboxDeps`; `configuredMailProviders(): MailProviderId[]`; `oauthCallbackUrl(provider): string`; `requestContext(headers: Headers): RequestContext`; `flashFromSearchParams(params: Record<string, string | string[] | undefined>): Flash | null` with `type Flash = { tone: "success" | "error" | "info"; message: string }`; `PROVIDER_LABEL: Record<MailProviderId, string>`; Server Actions `connectMailboxAction(formData)` and `disconnectMailboxAction(formData)`.

- [ ] **Step 1: Install workspace deps**

```bash
pnpm --filter @replywise/web add "@replywise/crypto@workspace:*" "@replywise/mail@workspace:*" "@replywise/mailbox@workspace:*"
```
Add `"@replywise/mail"` and `"@replywise/mailbox"` to `transpilePackages` in `apps/web/next.config.ts`.

- [ ] **Step 2: Write the failing unit test**

`apps/web/src/lib/mailbox-messages.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { flashFromSearchParams } from "./mailbox-messages";

describe("flashFromSearchParams", () => {
  it("returns nothing without a known flag", () => {
    expect(flashFromSearchParams({})).toBeNull();
    expect(flashFromSearchParams({ connected: "yahoo" })).toBeNull();
  });

  it("confirms connections and disconnections", () => {
    expect(flashFromSearchParams({ connected: "gmail" })).toEqual({
      tone: "success",
      message: "Gmail connected. Replywise can now read your mail and save drafts — it never sends email.",
    });
    expect(flashFromSearchParams({ disconnected: "gmail" })?.tone).toBe("success");
  });

  it("tells Outlook users to remove access themselves", () => {
    const flash = flashFromSearchParams({ disconnected: "outlook", manual: "1" });
    expect(flash?.tone).toBe("info");
    expect(flash?.message).toContain("account.microsoft.com");
  });

  it("explains every connect failure without echoing raw input", () => {
    for (const reason of [
      "not_configured",
      "invalid_state",
      "expired_state",
      "provider_mismatch",
      "access_denied",
      "missing_scopes",
      "provider_error",
    ]) {
      const flash = flashFromSearchParams({ error: reason });
      expect(flash?.tone).toBe("error");
      expect(flash?.message.length).toBeGreaterThan(10);
    }
    const unknown = flashFromSearchParams({ error: "<script>alert(1)</script>" });
    expect(unknown?.message).not.toContain("<script>");
  });

  it("uses the first value when a parameter repeats", () => {
    expect(flashFromSearchParams({ connected: ["outlook", "gmail"] })?.message).toMatch(/^Outlook/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @replywise/web test`
Expected: FAIL — cannot resolve `./mailbox-messages`.

- [ ] **Step 4: Implement**

`apps/web/src/lib/mailbox-messages.ts`:
```ts
import { isMailProviderId, type MailProviderId } from "@replywise/core";

export const PROVIDER_LABEL: Record<MailProviderId, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

export type Flash = { tone: "success" | "error" | "info"; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "This provider isn't set up yet. Add its OAuth client ID and secret to the server configuration.",
  invalid_state: "That connection link was invalid or already used. Please try connecting again.",
  expired_state: "The connection took too long and expired. Please try again.",
  provider_mismatch: "The connection response didn't match the provider you chose. Please try again.",
  access_denied: "You declined access, so nothing was connected.",
  missing_scopes:
    "Replywise needs permission to read mail and create drafts. Please try again and allow all requested permissions.",
  provider_error: "The provider returned an error. Please try again in a moment.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function flashFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): Flash | null {
  const error = first(params.error);
  if (error) {
    return {
      tone: "error",
      message: ERROR_MESSAGES[error] ?? "Something went wrong while connecting. Please try again.",
    };
  }
  const connected = first(params.connected);
  if (connected && isMailProviderId(connected)) {
    return {
      tone: "success",
      message: `${PROVIDER_LABEL[connected]} connected. Replywise can now read your mail and save drafts — it never sends email.`,
    };
  }
  const disconnected = first(params.disconnected);
  if (disconnected && isMailProviderId(disconnected)) {
    if (first(params.manual) === "1") {
      return {
        tone: "info",
        message: `${PROVIDER_LABEL[disconnected]} disconnected and its data deleted. To also remove Replywise's access, visit account.microsoft.com → Privacy → Apps and services.`,
      };
    }
    return {
      tone: "success",
      message: `${PROVIDER_LABEL[disconnected]} disconnected. Access was revoked and its data deleted.`,
    };
  }
  return null;
}
```

`apps/web/src/lib/crypto.ts`:
```ts
import "server-only";
import { createEncryptor, type Encryptor, LocalKeyProvider } from "@replywise/crypto";
import { getEnv } from "./env";

let encryptor: Encryptor | undefined;

export function getEncryptor(): Encryptor {
  encryptor ??= createEncryptor(LocalKeyProvider.fromEnv(getEnv().LOCAL_KEKS));
  return encryptor;
}
```

`apps/web/src/lib/mailbox.ts`:
```ts
import "server-only";
import { MAIL_PROVIDERS, type MailProviderId } from "@replywise/core";
import { createMailOAuthProviders, type MailOAuthProviders } from "@replywise/mail";
import type { MailboxDeps, RequestContext } from "@replywise/mailbox";
import { getEncryptor } from "./crypto";
import { getDb } from "./db";
import { getEnv } from "./env";

let providers: MailOAuthProviders | undefined;

function getProviders(): MailOAuthProviders {
  const env = getEnv();
  providers ??= createMailOAuthProviders({
    gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET },
    outlook: { clientId: env.OUTLOOK_CLIENT_ID, clientSecret: env.OUTLOOK_CLIENT_SECRET },
  });
  return providers;
}

export function getMailboxDeps(): MailboxDeps {
  return { db: getDb(), encryptor: getEncryptor(), providers: getProviders() };
}

export function configuredMailProviders(): MailProviderId[] {
  const enabled = getProviders();
  return MAIL_PROVIDERS.filter((id) => enabled[id] !== undefined);
}

export function oauthCallbackUrl(provider: MailProviderId): string {
  return new URL(`/api/oauth/${provider}/callback`, getEnv().APP_URL).toString();
}

export function requestContext(headers: Headers): RequestContext {
  return {
    ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    userAgent: headers.get("user-agent")?.slice(0, 300) ?? null,
  };
}
```

`apps/web/src/app/api/oauth/[provider]/callback/route.ts`:
```ts
import { isMailProviderId } from "@replywise/core";
import { ConnectError, completeConnect, MAILBOXES_PATH } from "@replywise/mailbox";
import { type NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getMailboxDeps, oauthCallbackUrl, requestContext } from "@/lib/mailbox";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/oauth/[provider]/callback">,
) {
  const back = (params: Record<string, string>) =>
    NextResponse.redirect(new URL(`${MAILBOXES_PATH}?${new URLSearchParams(params)}`, request.url));

  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url));

  const { provider } = await ctx.params;
  if (!isMailProviderId(provider)) return back({ error: "not_configured" });

  const query = request.nextUrl.searchParams;
  const providerError = query.get("error");
  if (providerError) {
    return back({ error: providerError === "access_denied" ? "access_denied" : "provider_error" });
  }
  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state) return back({ error: "invalid_state" });

  try {
    await completeConnect(getMailboxDeps(), {
      userId: session.user.id,
      provider,
      code,
      state,
      redirectUri: oauthCallbackUrl(provider),
      context: requestContext(request.headers),
    });
    return back({ connected: provider });
  } catch (error) {
    if (error instanceof ConnectError) return back({ error: error.reason });
    console.error("mailbox connect failed", error instanceof Error ? error.name : "unknown");
    return back({ error: "provider_error" });
  }
}
```

`apps/web/src/app/(app)/settings/mailboxes/actions.ts`:
```ts
"use server";

import { isMailProviderId } from "@replywise/core";
import {
  ConnectError,
  disconnectMailbox,
  MAILBOXES_PATH,
  MailAccountNotFoundError,
  startConnect,
} from "@replywise/mailbox";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getMailboxDeps, oauthCallbackUrl, requestContext } from "@/lib/mailbox";

/** Starts the OAuth flow. POST-only (Server Action), so other sites cannot trigger it. */
export async function connectMailboxAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const provider = String(formData.get("provider") ?? "");
  if (!isMailProviderId(provider)) redirect(`${MAILBOXES_PATH}?error=not_configured`);
  const loginHint = String(formData.get("loginHint") ?? "").trim();

  let authorizationUrl: string;
  try {
    authorizationUrl = await startConnect(getMailboxDeps(), {
      userId: user.id,
      provider,
      redirectUri: oauthCallbackUrl(provider),
      ...(loginHint ? { loginHint } : {}),
    });
  } catch (error) {
    if (error instanceof ConnectError) redirect(`${MAILBOXES_PATH}?error=${error.reason}`);
    throw error;
  }
  redirect(authorizationUrl);
}

export async function disconnectMailboxAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const mailAccountId = String(formData.get("mailAccountId") ?? "");

  let target: string;
  try {
    const result = await disconnectMailbox(getMailboxDeps(), {
      userId: user.id,
      mailAccountId,
      context: requestContext(await headers()),
    });
    target = `${MAILBOXES_PATH}?disconnected=${result.provider}${result.revoked ? "" : "&manual=1"}`;
  } catch (error) {
    if (error instanceof MailAccountNotFoundError) target = MAILBOXES_PATH;
    else throw error;
  }
  redirect(target);
}
```

Note the deliberate structure: `redirect()` throws a control-flow error, so it is never called inside a `try` whose `catch` would swallow it (except in the `catch` branch itself, where nothing catches it).

- [ ] **Step 5: Run tests and checks**

Run: `pnpm --filter @replywise/web test && pnpm --filter @replywise/web typecheck && pnpm lint && pnpm --filter @replywise/web build`
Expected: 17 tests PASS (12 + 5); typecheck, lint and build succeed; build output lists `ƒ /api/oauth/[provider]/callback`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): add OAuth callback route and mailbox server actions"
```

---

### Task 10: Web — Mailboxes settings page, entry points and e2e

**Files:**
- Create (generator): `apps/web/src/components/ui/{alert-dialog,badge}.tsx`
- Create: `apps/web/src/components/mailboxes/{flash,mailbox-list,connect-buttons,disconnect-button}.tsx`
- Create: `apps/web/src/app/(app)/settings/mailboxes/page.tsx`
- Modify: `apps/web/src/components/inbox/empty-inbox.tsx`, `apps/web/src/app/(app)/inbox/page.tsx`, `apps/web/src/app/(app)/settings/page.tsx`, `apps/web/playwright.config.ts`
- Test: `apps/web/e2e/mailboxes.spec.ts`

**Interfaces:**
- Consumes: Task 9 (`connectMailboxAction`, `disconnectMailboxAction`, `flashFromSearchParams`, `PROVIDER_LABEL`, `configuredMailProviders`, `getDb`), `listMailAccounts`, `MailAccountSummary` (db), `requireUser`.
- Produces: page `/settings/mailboxes`; `EmptyInbox({ title, description, action? })`.

- [ ] **Step 1: Add shadcn components**

Run (from `apps/web`): `pnpm dlx shadcn@latest add alert-dialog badge -y`
Expected: `src/components/ui/alert-dialog.tsx` and `badge.tsx` created.

- [ ] **Step 2: Write the failing e2e test**

In `apps/web/playwright.config.ts`, give the web server dummy Gmail credentials when none are configured, so the redirect can be asserted without real Google access:
```ts
  webServer: {
    // Always test a production build: `next dev` compiles routes on demand, which made
    // first navigations take >5s and tests flaky. CI builds in an earlier step.
    command: process.env.CI ? "pnpm start" : "pnpm build && pnpm start",
    url: "http://localhost:3000/sign-in",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      ...(process.env as Record<string, string>),
      GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID || "e2e-gmail-client-id",
      GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET || "e2e-gmail-client-secret",
    },
  },
```

`apps/web/e2e/mailboxes.spec.ts`:
```ts
import { expect, type Page, test } from "@playwright/test";

async function signUp(page: Page) {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Mailbox Tester");
  await page.getByLabel("Email").fill(`e2e-mb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
}

test("the inbox points new users to the mailboxes page", async ({ page }) => {
  await signUp(page);
  await page.getByRole("link", { name: "Connect a mailbox" }).click();
  await expect(page).toHaveURL(/\/settings\/mailboxes$/);
  await expect(page.getByRole("heading", { name: "Mailboxes" })).toBeVisible();
  await expect(page.getByText("No mailboxes connected yet.")).toBeVisible();
});

test("connecting Gmail redirects to Google with PKCE and minimal scopes", async ({ page }) => {
  await signUp(page);
  let authorizeUrl: URL | null = null;
  await page.route("https://accounts.google.com/**", async (route) => {
    authorizeUrl = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Google (stub)</h1>" });
  });

  await page.goto("/settings/mailboxes");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(page.getByRole("heading", { name: "Google (stub)" })).toBeVisible();

  const url = authorizeUrl as URL | null;
  expect(url?.pathname).toBe("/o/oauth2/v2/auth");
  const params = url?.searchParams;
  expect(params?.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/gmail/callback");
  expect(params?.get("code_challenge_method")).toBe("S256");
  expect(params?.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params?.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params?.get("access_type")).toBe("offline");
  expect(params?.get("scope")).toBe(
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
  );
});

test("a forged callback state is rejected with a clear message", async ({ page }) => {
  await signUp(page);
  await page.goto("/api/oauth/gmail/callback?code=attacker-code&state=forged-state");
  await expect(page).toHaveURL(/\/settings\/mailboxes\?error=invalid_state$/);
  await expect(page.getByRole("alert")).toContainText("invalid or already used");
});

test("declining consent explains that nothing was connected", async ({ page }) => {
  await signUp(page);
  await page.goto("/api/oauth/gmail/callback?error=access_denied&state=anything");
  await expect(page.getByRole("alert")).toContainText("You declined access");
});

test("the callback requires a signed-in user", async ({ request }) => {
  const response = await request.get("/api/oauth/gmail/callback?code=x&state=y", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toMatch(/\/sign-in$/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @replywise/web e2e --reporter=line -g "mailbox|Gmail|callback|consent"`
Expected: FAIL — `/settings/mailboxes` is a 404 / "Connect a mailbox" link not found.

- [ ] **Step 4: Implement the UI**

`apps/web/src/components/mailboxes/flash.tsx`:
```tsx
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { flashFromSearchParams } from "@/lib/mailbox-messages";

const ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const;

/** Reads searchParams; render inside <Suspense>. */
export async function MailboxFlash({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const flash = flashFromSearchParams(await searchParams);
  if (!flash) return null;
  const Icon = ICON[flash.tone];
  return (
    <div
      role={flash.tone === "error" ? "alert" : "status"}
      className={cn(
        "mt-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        flash.tone === "error" && "border-destructive/40 bg-destructive/5 text-destructive",
        flash.tone === "success" && "border-border bg-muted/50",
        flash.tone === "info" && "border-border bg-muted/50",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{flash.message}</p>
    </div>
  );
}
```

`apps/web/src/components/mailboxes/connect-buttons.tsx`:
```tsx
import { MAIL_PROVIDERS, type MailProviderId } from "@replywise/core";
import { connectMailboxAction } from "@/app/(app)/settings/mailboxes/actions";
import { Button } from "@/components/ui/button";
import { PROVIDER_LABEL } from "@/lib/mailbox-messages";

export function ConnectButtons({ configured }: { configured: MailProviderId[] }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      {MAIL_PROVIDERS.map((provider) => {
        const enabled = configured.includes(provider);
        return (
          <form key={provider} action={connectMailboxAction}>
            <input type="hidden" name="provider" value={provider} />
            <Button
              type="submit"
              variant="outline"
              disabled={!enabled}
              title={enabled ? undefined : `${PROVIDER_LABEL[provider]} is not configured on this server`}
              className="w-full sm:w-auto"
            >
              Connect {PROVIDER_LABEL[provider]}
            </Button>
          </form>
        );
      })}
    </div>
  );
}
```

`apps/web/src/components/mailboxes/disconnect-button.tsx`:
```tsx
"use client";

import { disconnectMailboxAction } from "@/app/(app)/settings/mailboxes/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function DisconnectButton({ mailAccountId, email }: { mailAccountId: string; email: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Disconnect ${email}`}>
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Replywise will stop reading this mailbox and delete everything it stored for it. Drafts
            already saved in your mailbox stay there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={disconnectMailboxAction}>
            <input type="hidden" name="mailAccountId" value={mailAccountId} />
            <AlertDialogAction type="submit">Disconnect</AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

`apps/web/src/components/mailboxes/mailbox-list.tsx`:
```tsx
import { listMailAccounts, type MailAccountSummary } from "@replywise/db";
import { Mail } from "lucide-react";
import { connectMailboxAction } from "@/app/(app)/settings/mailboxes/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { configuredMailProviders } from "@/lib/mailbox";
import { PROVIDER_LABEL } from "@/lib/mailbox-messages";
import { ConnectButtons } from "./connect-buttons";
import { DisconnectButton } from "./disconnect-button";

const STATUS: Record<MailAccountSummary["status"], { label: string; variant: "secondary" | "destructive" }> = {
  active: { label: "Connected", variant: "secondary" },
  needs_reauth: { label: "Reconnect needed", variant: "destructive" },
  error: { label: "Error", variant: "destructive" },
};

/** Reads the session and DB; render inside <Suspense>. */
export async function MailboxList() {
  const user = await requireUser();
  const accounts = await listMailAccounts(getDb(), user.id);
  const configured = configuredMailProviders();

  return (
    <div className="mt-8 flex flex-col gap-6">
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No mailboxes connected yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {accounts.map((account) => {
            const status = STATUS[account.status];
            return (
              <li key={account.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Mail className="size-4 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account.emailAddress}</p>
                  <p className="text-xs text-muted-foreground">{PROVIDER_LABEL[account.provider]}</p>
                </div>
                <Badge variant={status.variant}>{status.label}</Badge>
                {account.status !== "active" && configured.includes(account.provider) ? (
                  <form action={connectMailboxAction}>
                    <input type="hidden" name="provider" value={account.provider} />
                    <input type="hidden" name="loginHint" value={account.emailAddress} />
                    <Button type="submit" size="sm">
                      Reconnect
                    </Button>
                  </form>
                ) : null}
                <DisconnectButton mailAccountId={account.id} email={account.emailAddress} />
              </li>
            );
          })}
        </ul>
      )}
      <ConnectButtons configured={configured} />
    </div>
  );
}

export function MailboxListSkeleton() {
  return (
    <div className="mt-8 flex flex-col gap-3" aria-hidden>
      <div className="h-14 animate-pulse rounded-lg bg-muted" />
      <div className="h-9 w-40 animate-pulse rounded-md bg-muted" />
    </div>
  );
}
```

`apps/web/src/app/(app)/settings/mailboxes/page.tsx`:
```tsx
import Link from "next/link";
import { Suspense } from "react";
import { MailboxFlash } from "@/components/mailboxes/flash";
import { MailboxList, MailboxListSkeleton } from "@/components/mailboxes/mailbox-list";

export const metadata = { title: "Mailboxes" };

export default function MailboxesPage({ searchParams }: PageProps<"/settings/mailboxes">) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground">
        ← Settings
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Mailboxes</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect Gmail or Outlook. Replywise reads your mail and saves reply drafts to your mailbox —
        it never sends email.
      </p>
      <Suspense fallback={null}>
        <MailboxFlash searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<MailboxListSkeleton />}>
        <MailboxList />
      </Suspense>
    </div>
  );
}
```

Replace `apps/web/src/components/inbox/empty-inbox.tsx`:
```tsx
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyInbox({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="text-base font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
```

Replace `apps/web/src/app/(app)/inbox/page.tsx`:
```tsx
import Link from "next/link";
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { Button } from "@/components/ui/button";

export const metadata = { title: "All mail" };

export default function InboxPage() {
  return (
    <EmptyInbox
      title="No mailboxes connected"
      description="Connect Gmail or Outlook and Replywise will sort new mail into Urgent, Important, Needs Reply, Informational and Low Priority."
      action={
        <Button asChild size="sm">
          <Link href="/settings/mailboxes">Connect a mailbox</Link>
        </Button>
      }
    />
  );
}
```

In `apps/web/src/app/(app)/settings/page.tsx`, add `import Link from "next/link";` and insert this section **before** the Appearance section:
```tsx
      <section className="mt-8 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">Mailboxes</h2>
          <p className="text-sm text-muted-foreground">Connect, reconnect or remove Gmail and Outlook accounts.</p>
        </div>
        <Link href="/settings/mailboxes" className="text-sm font-medium underline-offset-4 hover:underline">
          Manage mailboxes →
        </Link>
      </section>
```
and change the Appearance `<section>`'s top margin class from `mt-8` to `mt-6`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @replywise/web e2e --reporter=line`
Expected: 11 tests PASS (6 existing + 5 new). The existing test "a new user signs up, sees the app shell…" still finds the "No mailboxes connected" heading.

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): add mailboxes settings page with connect, reconnect and disconnect"
```

---

### Task 11: Developer docs and verification with real accounts

**Files:**
- Modify: `README.md`

This task needs the user: real OAuth client credentials (Google Cloud and/or Microsoft Entra) placed in `D:\replywise\.env` (never in chat, never committed).

- [ ] **Step 1: Document credential setup**

Append to `README.md`:
````markdown
## Connecting mailboxes in development

Replywise never asks for mailbox passwords; it uses OAuth. Each provider needs an OAuth client
registered once by the developer. Put the values in `.env` (git-ignored).

### Gmail (Google Cloud)

1. console.cloud.google.com → create a project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen** → User type **External** → keep **Testing** → add your Gmail under **Test users**.
   (Testing mode allows up to 100 test users without Google's verification. A public launch requires
   OAuth verification and an annual CASA assessment for these restricted scopes.)
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI: `http://localhost:3000/api/oauth/gmail/callback`
4. Copy the values into `.env`: `GMAIL_CLIENT_ID=…` and `GMAIL_CLIENT_SECRET=…`

### Outlook (Microsoft Entra ID)

1. portal.azure.com → **Microsoft Entra ID → App registrations → New registration**.
   Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   Redirect URI (Web): `http://localhost:3000/api/oauth/outlook/callback`
2. **Certificates & secrets → New client secret** → copy the secret **value**.
3. **API permissions → Microsoft Graph → Delegated**: `offline_access`, `User.Read`, `Mail.ReadWrite`.
   Never add `Mail.Send` — Replywise does not send email.
4. `.env`: `OUTLOOK_CLIENT_ID=<Application (client) ID>` and `OUTLOOK_CLIENT_SECRET=<secret value>`

Restart the dev server after editing `.env`, then open **Settings → Mailboxes**.
````

- [ ] **Step 2: Full automated verification**

Run:
```bash
"/c/Program Files/Docker/Docker/resources/bin/docker.exe" compose up -d --wait
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test && pnpm test:int && pnpm --filter @replywise/web e2e
```
Expected: everything passes. Expected totals: unit tests (core 5, config 6, crypto 14, observability 4, mail 18, web 17), integration (db 12, queue 5, worker 3, mailbox 18), e2e 11.

- [ ] **Step 3: Manual verification with a real Gmail account** (requires the user's credentials in `.env`)

1. `pnpm --filter @replywise/web dev`, sign in, open **Settings → Mailboxes**, click **Connect Gmail**, approve on Google's screen.
2. Expected: back on Mailboxes with "Gmail connected…" and the address listed as **Connected**.
3. Confirm tokens are encrypted at rest:
```bash
"/c/Program Files/Docker/Docker/resources/bin/docker.exe" compose exec -T postgres psql -U replywise -d replywise -tAc "select email_address, status, array_to_string(granted_scopes, ' '), position('ya29' in encode(tokens_ciphertext, 'escape')) from mail_accounts;"
```
Expected: one row, status `active`, both Gmail scopes, and position `0` (no plaintext access token).
4. Click **Disconnect** → confirm. Expected: "Gmail disconnected. Access was revoked…"; myaccount.google.com → Security → Third-party connections no longer lists the app.
5. `select action from audit_logs order by created_at;` → `mailbox.connected`, `mailbox.disconnected`.
6. Repeat 1–4 for Outlook if its credentials are configured (expected disconnect message: the manual-removal note).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add mailbox OAuth setup for development"
```

---

## Definition of done (M2)

- A user can connect Gmail and Outlook with OAuth + PKCE, see them listed, reconnect a `needs_reauth` mailbox, and disconnect (revoking at Google, deleting all local data).
- Tokens and code verifiers are stored only encrypted with row-bound AAD; state is single-use, user-bound, hashed and expires in 10 minutes; missing scopes are refused.
- `getValidAccessToken` refreshes exactly once under concurrency and flips mailboxes to `needs_reauth` on `invalid_grant` (ready for M3 sync).
- No provider code references any send endpoint or `Mail.Send` (test-enforced).
- All automated suites pass; a real Gmail connection was verified manually.
