# Replywise M1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable, tested monorepo skeleton: shared domain/config/crypto/logging/db/queue packages, a worker running a real maintenance job, and a themed, responsive Next.js app shell behind working email+password authentication, with Dockerfiles and CI.

**Architecture:** pnpm + Turborepo monorepo. Internal packages ship TypeScript source (`exports` → `src/index.ts`) and are compiled by their consumers (Next.js `transpilePackages`, `tsx`, `tsup`, Vitest). Postgres via Drizzle, Redis via BullMQ. Unit tests run without infrastructure; integration tests (`*.int.test.ts`) run against the Docker Compose Postgres/Redis.

**Tech Stack:** Node.js 24 (≥ 22), TypeScript strict, pnpm, Turborepo 2, Biome 2, Vitest, Next.js (App Router) + React 19, Tailwind CSS 4, shadcn/ui, next-themes, Better Auth, Drizzle ORM + drizzle-kit, postgres.js, BullMQ 5 + ioredis, Zod, pino, Playwright, tsup, dotenv-cli.

**Spec:** `docs/superpowers/specs/2026-11-15-replywise-design.md` (read §2, §3, §4, §5 item 1, §6, §11, §12 before starting).

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` everywhere; ESM (`"type": "module"`) in every package.
- Package scope is `@replywise/*`; packages never import from `apps/*`; `@replywise/core` imports nothing.
- Dependency versions are whatever `pnpm add` resolves at execution time (latest stable); the lockfile is committed. If an installed library's API differs from the code in this plan, adapt to the installed version's documented API and say so in the task's commit message.
- Never log secrets or email content. Env validation errors name keys, never values.
- Every encrypted value uses `@replywise/crypto` with an AAD from `aad.*` helpers.
- Default AI model ids live only in `@replywise/core` (`claude-opus-5-5`).
- Integration tests use `DATABASE_URL_TEST` (default `postgres://replywise:replywise@localhost:5432/replywise_test`) and `REDIS_URL_TEST` (default `redis://localhost:6379`), never the dev database.
- Commit after every task with a Conventional Commit message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Shell examples are POSIX (Git Bash on Windows works).

## File map (M1)

```
.
├─ package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  biome.json
├─ .gitignore  .dockerignore  .nvmrc  .env.example  docker-compose.yml  README.md
├─ docker/postgres/init.sql
├─ .github/workflows/ci.yml
├─ packages/
│  ├─ core/          src/{index,categories,mail,ai}.ts  src/categories.test.ts
│  ├─ config/        src/{index,env}.ts  src/env.test.ts
│  ├─ crypto/        src/{index,errors,key-provider,local-key-provider,envelope,aad}.ts  src/envelope.test.ts  src/local-key-provider.test.ts
│  ├─ observability/ src/{index,logger}.ts  src/logger.test.ts
│  ├─ db/            drizzle.config.ts  migrations/  src/{index,client,columns,migrate,testing}.ts
│  │                 src/bin/migrate.ts  src/schema/{index,enums,auth,mail,ai,audit}.ts
│  │                 src/queries/maintenance.ts  src/schema.int.test.ts  src/queries/maintenance.int.test.ts
│  └─ queue/         src/{index,jobs,bullmq}.ts  src/bullmq.int.test.ts
└─ apps/
   ├─ worker/        tsup.config.ts  Dockerfile  src/{index,env,main}.ts  src/jobs/purge-bodies.ts  src/main.int.test.ts
   └─ web/           next.config.ts  vitest.config.ts  vitest.setup.ts  playwright.config.ts  Dockerfile
                     src/lib/{env,db,auth,auth-client,security-headers,initials,utils}.ts
                     src/components/{theme-provider,theme-toggle,theme-selector}.tsx
                     src/components/app-shell/{app-shell,sidebar-content,nav-links,mobile-nav,user-menu}.tsx + nav-items.ts
                     src/components/auth/{sign-in-form,sign-up-form}.tsx  src/components/inbox/empty-inbox.tsx
                     src/app/{layout,page}.tsx  src/app/(auth)/{layout,sign-in/page,sign-up/page}.tsx
                     src/app/(app)/{layout,inbox/page,inbox/[category]/page,settings/page}.tsx
                     src/app/api/auth/[...all]/route.ts  e2e/auth.spec.ts
```

---

### Task 1: Monorepo scaffold, tooling, local infrastructure, `@replywise/core`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.nvmrc`, `.env.example`, `docker-compose.yml`, `docker/postgres/init.sql`, `README.md`
- Create: `packages/core/{package.json,tsconfig.json,vitest.config.ts}`, `packages/core/src/{index,categories,mail,ai}.ts`
- Test: `packages/core/src/categories.test.ts`

**Interfaces:**
- Produces (`@replywise/core`): `INBOX_CATEGORIES` (precedence order), `InboxCategory`, `CATEGORY_META: Record<InboxCategory, {label, slug, description}>`, `categoryFromSlug(slug: string): InboxCategory | null`, `MAIL_PROVIDERS`, `MailProviderId`, `EmailAddress {name: string | null; address: string}`, `AI_PROVIDERS`, `AiProviderId`, `AI_TASKS`, `AiTask`, `REPLY_TONES`, `ReplyTone`, `DEFAULT_AI_MODELS {classification, generation}`.
- Produces (repo conventions every later task uses): package template (below), scripts `test` (unit), `test:int` (integration), `typecheck`.

- [ ] **Step 1: Root workspace files**

`package.json`:
```json
{
  "name": "replywise",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "biome check .",
    "format": "biome check --write .",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:int": "turbo run test:int --concurrency=1",
    "db:generate": "pnpm --filter @replywise/db generate",
    "db:migrate": "pnpm --filter @replywise/db migrate"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalPassThroughEnv": [
    "NODE_ENV", "CI", "APP_URL", "DATABASE_URL", "DATABASE_URL_TEST", "REDIS_URL", "REDIS_URL_TEST",
    "LOCAL_KEKS", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "LOG_LEVEL"
  ],
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "!.next/cache/**", "dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "typecheck": {},
    "test": {},
    "test:int": { "cache": false },
    "e2e": { "cache": false }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`.nvmrc`:
```
24
```

`.gitignore`:
```
node_modules/
.next/
dist/
.turbo/
coverage/
playwright-report/
test-results/
*.tsbuildinfo
.env
.env.*
!.env.example
.claude/worktrees/
```

- [ ] **Step 2: Install root tooling**

Run:
```bash
corepack enable
corepack use pnpm@latest
pnpm add -Dw turbo typescript @biomejs/biome vitest @types/node
pnpm exec biome init
```
Expected: `packageManager` is written into `package.json`; `biome.json` exists.

Replace `biome.json` with:
```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "includes": ["**", "!**/migrations/**", "!**/components/ui/**", "!**/next-env.d.ts"]
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": {
    "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" }
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```
If `pnpm exec biome check .` reports a configuration error because the installed major is not 2.x, run `pnpm exec biome migrate --write` and keep the migrated file.

- [ ] **Step 3: Local infrastructure**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: replywise
      POSTGRES_PASSWORD: replywise
      POSTGRES_DB: replywise
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U replywise"]
      interval: 2s
      timeout: 3s
      retries: 20
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
volumes:
  pgdata:
```

`docker/postgres/init.sql`:
```sql
CREATE DATABASE replywise_test;
```

`.env.example`:
```bash
NODE_ENV=development
APP_URL=http://localhost:3000
DATABASE_URL=postgres://replywise:replywise@localhost:5432/replywise
DATABASE_URL_TEST=postgres://replywise:replywise@localhost:5432/replywise_test
REDIS_URL=redis://localhost:6379
REDIS_URL_TEST=redis://localhost:6379
# Key-encryption keys, newest last. Generate one with:
# node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"
LOCAL_KEKS=
# node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
BETTER_AUTH_SECRET=
# Optional: "Sign in with Google" for app login only (scopes: openid email profile)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
LOG_LEVEL=info
```

Run: `docker compose up -d --wait`
Expected: both services report `Healthy`.

- [ ] **Step 4: Create `@replywise/core` package skeleton**

This is the template every package in this plan follows (only `name` changes).

`packages/core/package.json`:
```json
{
  "name": "@replywise/core",
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

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "*.ts"] }
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["src/**/*.int.test.ts", "node_modules/**"] },
});
```

`packages/core/vitest.int.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.int.test.ts"], fileParallelism: false, testTimeout: 30_000 },
});
```

Run: `pnpm --filter @replywise/core add -D vitest typescript @types/node`

- [ ] **Step 5: Write the failing test**

`packages/core/src/categories.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CATEGORY_META, INBOX_CATEGORIES, categoryFromSlug } from "./categories";

describe("inbox categories", () => {
  it("are listed in precedence order", () => {
    expect(INBOX_CATEGORIES).toEqual([
      "urgent",
      "important",
      "needs_reply",
      "informational",
      "low_priority",
    ]);
  });

  it("have unique, URL-safe slugs", () => {
    const slugs = INBOX_CATEGORIES.map((c) => CATEGORY_META[c].slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("round-trip through categoryFromSlug", () => {
    for (const category of INBOX_CATEGORIES) {
      expect(categoryFromSlug(CATEGORY_META[category].slug)).toBe(category);
    }
  });

  it("reject unknown slugs and raw enum values", () => {
    expect(categoryFromSlug("spam")).toBeNull();
    expect(categoryFromSlug("needs_reply")).toBeNull();
    expect(categoryFromSlug("")).toBeNull();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @replywise/core test`
Expected: FAIL — cannot resolve `./categories`.

- [ ] **Step 7: Implement `@replywise/core`**

`packages/core/src/categories.ts`:
```ts
/** Ordered by precedence: a thread's primary bucket is the first one that applies. */
export const INBOX_CATEGORIES = [
  "urgent",
  "important",
  "needs_reply",
  "informational",
  "low_priority",
] as const;

export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

export interface CategoryMeta {
  label: string;
  slug: string;
  description: string;
}

export const CATEGORY_META: Readonly<Record<InboxCategory, CategoryMeta>> = {
  urgent: {
    label: "Urgent",
    slug: "urgent",
    description: "Time-sensitive and needs your attention now.",
  },
  important: {
    label: "Important",
    slug: "important",
    description: "Matters to you, but nothing is on fire.",
  },
  needs_reply: {
    label: "Needs Reply",
    slug: "needs-reply",
    description: "Someone is waiting on your answer.",
  },
  informational: {
    label: "Informational",
    slug: "informational",
    description: "Worth knowing, no action needed.",
  },
  low_priority: {
    label: "Low Priority",
    slug: "low-priority",
    description: "Newsletters, notifications and noise.",
  },
};

export function categoryFromSlug(slug: string): InboxCategory | null {
  return INBOX_CATEGORIES.find((category) => CATEGORY_META[category].slug === slug) ?? null;
}
```

`packages/core/src/mail.ts`:
```ts
export const MAIL_PROVIDERS = ["gmail", "outlook"] as const;
export type MailProviderId = (typeof MAIL_PROVIDERS)[number];

export interface EmailAddress {
  name: string | null;
  address: string;
}
```

`packages/core/src/ai.ts`:
```ts
export const AI_PROVIDERS = ["anthropic"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const AI_TASKS = ["classify", "summarize", "draft"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const REPLY_TONES = ["professional", "friendly", "concise", "formal", "casual"] as const;
export type ReplyTone = (typeof REPLY_TONES)[number];

/** Defaults only; users choose per-task models in Settings. */
export const DEFAULT_AI_MODELS = {
  classification: "claude-opus-5-5",
  generation: "claude-opus-5-5",
} as const;
```

`packages/core/src/index.ts`:
```ts
export * from "./ai";
export * from "./categories";
export * from "./mail";
```

- [ ] **Step 8: Run tests, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 4 tests PASS; typecheck and lint exit 0 (run `pnpm format` first if lint reports formatting only).

- [ ] **Step 9: README**

`README.md`:
````markdown
# Replywise

AI email assistant: classifies, summarizes and drafts replies into your Gmail/Outlook drafts. Never sends email.

Design: `docs/superpowers/specs/2026-11-15-replywise-design.md`

## Local development

Requirements: Node 24 (see `.nvmrc`), Docker, Corepack.

```bash
corepack enable
pnpm install
cp .env.example .env   # then fill LOCAL_KEKS and BETTER_AUTH_SECRET (commands in the file)
docker compose up -d --wait
pnpm db:migrate
pnpm dev               # web on http://localhost:3000 + worker
```

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # no infrastructure needed
pnpm test:int                              # needs docker compose up
pnpm --filter @replywise/web e2e           # needs docker compose up + migrated dev DB
```
````

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo tooling, local infra and @replywise/core"
```

---

### Task 2: `@replywise/config` — validated environment

**Files:**
- Create: `packages/config/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts}` (Task 1 template, name `@replywise/config`)
- Create: `packages/config/src/{env,index}.ts`
- Test: `packages/config/src/env.test.ts`

**Interfaces:**
- Produces: `baseEnvSchema`, `workerEnvSchema`, `webEnvSchema` (Zod objects); `type WorkerEnv`, `type WebEnv`; `parseEnv<S extends z.ZodType>(schema: S, source: Record<string, string | undefined>): z.output<S>`; `class EnvValidationError extends Error { invalidKeys: string[] }`.

- [ ] **Step 1: Create package and install deps**

Copy the Task 1 template files into `packages/config/` with `"name": "@replywise/config"`, then:
```bash
pnpm --filter @replywise/config add zod
pnpm --filter @replywise/config add -D vitest typescript @types/node
```

- [ ] **Step 2: Write the failing test**

`packages/config/src/env.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv, webEnvSchema, workerEnvSchema } from "./env";

const KEK = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  LOCAL_KEKS: KEK,
};

describe("parseEnv", () => {
  it("parses a valid worker environment and applies defaults", () => {
    const env = parseEnv(workerEnvSchema, base);
    expect(env).toMatchObject({ ...base, NODE_ENV: "development", LOG_LEVEL: "info" });
  });

  it("treats empty strings as unset so optional keys stay optional", () => {
    const env = parseEnv(webEnvSchema, {
      ...base,
      APP_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "x".repeat(32),
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    });
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it("lists invalid keys without leaking their values", () => {
    const secretLooking = "postgres-password-should-not-leak";
    let caught: unknown;
    try {
      parseEnv(workerEnvSchema, { ...base, DATABASE_URL: secretLooking, REDIS_URL: undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const error = caught as EnvValidationError;
    expect(error.invalidKeys).toEqual(["DATABASE_URL", "REDIS_URL"]);
    expect(error.message).not.toContain(secretLooking);
  });

  it("requires a 32+ character auth secret for the web app", () => {
    expect(() =>
      parseEnv(webEnvSchema, { ...base, APP_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "short" }),
    ).toThrow(EnvValidationError);
  });

  it("rejects malformed LOCAL_KEKS", () => {
    expect(() => parseEnv(workerEnvSchema, { ...base, LOCAL_KEKS: "not-a-key" })).toThrow(
      EnvValidationError,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @replywise/config test`
Expected: FAIL — cannot resolve `./env`.

- [ ] **Step 4: Implement**

`packages/config/src/env.ts`:
```ts
import { z } from "zod";

const KEK_LIST = /^[\w-]+:[A-Za-z0-9+/]+=*(,[\w-]+:[A-Za-z0-9+/]+=*)*$/;

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  LOCAL_KEKS: z.string().regex(KEK_LIST, "expected id:base64[,id:base64...]"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const workerEnvSchema = baseEnvSchema;

export const webEnvSchema = baseEnvSchema.extend({
  APP_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

export type WorkerEnv = z.output<typeof workerEnvSchema>;
export type WebEnv = z.output<typeof webEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly invalidKeys: string[]) {
    super(`Invalid or missing environment variables: ${invalidKeys.join(", ")}`);
    this.name = "EnvValidationError";
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined>,
): z.output<S> {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const keys = new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "(root)")));
    throw new EnvValidationError([...keys].sort());
  }
  return result.data;
}
```

`packages/config/src/index.ts`:
```ts
export * from "./env";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/config test && pnpm --filter @replywise/config typecheck`
Expected: 5 tests PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(config): add zod-validated environment parsing"
```

---

### Task 3: `@replywise/crypto` — envelope encryption

**Files:**
- Create: `packages/crypto/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts}` (template, name `@replywise/crypto`)
- Create: `packages/crypto/src/{errors,key-provider,local-key-provider,envelope,aad,index}.ts`
- Test: `packages/crypto/src/local-key-provider.test.ts`, `packages/crypto/src/envelope.test.ts`

**Interfaces:**
- Produces: `interface KeyProvider { readonly currentKeyId: string; wrapKey(dataKey: Buffer, keyId: string): Promise<Buffer>; unwrapKey(wrapped: Buffer, keyId: string): Promise<Buffer> }`; `class LocalKeyProvider implements KeyProvider` with `static fromEnv(value: string)`; `interface Encryptor { encrypt(plaintext: string | Buffer, aad: string): Promise<Buffer>; decrypt(blob: Buffer, aad: string): Promise<Buffer>; decryptString(blob: Buffer, aad: string): Promise<string>; keyIdOf(blob: Buffer): string }`; `createEncryptor(keys: KeyProvider): Encryptor`; `class DecryptionError`; `aad.{aiCredential(userId, provider), mailTokens(mailAccountId), messageBody(messageId), replyDraft(draftId), oauthVerifier(stateHash)}`.

- [ ] **Step 1: Create package**

Template files with `"name": "@replywise/crypto"`, then `pnpm --filter @replywise/crypto add -D vitest typescript @types/node`.

- [ ] **Step 2: Write the failing tests**

`packages/crypto/src/local-key-provider.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DecryptionError } from "./errors";
import { LocalKeyProvider } from "./local-key-provider";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");

describe("LocalKeyProvider", () => {
  it("uses the last key in the list as the current key", () => {
    const provider = LocalKeyProvider.fromEnv(`v1:${key(1)},v2:${key(2)}`);
    expect(provider.currentKeyId).toBe("v2");
  });

  it("wraps and unwraps a data key", async () => {
    const provider = LocalKeyProvider.fromEnv(`v1:${key(1)}`);
    const dataKey = Buffer.alloc(32, 9);
    const wrapped = await provider.wrapKey(dataKey, "v1");
    expect(wrapped.equals(dataKey)).toBe(false);
    expect((await provider.unwrapKey(wrapped, "v1")).equals(dataKey)).toBe(true);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => LocalKeyProvider.fromEnv(`v1:${Buffer.alloc(16).toString("base64")}`)).toThrow(
      /32 bytes/,
    );
  });

  it("rejects malformed entries and duplicate ids", () => {
    expect(() => LocalKeyProvider.fromEnv("nocolon")).toThrow(/id:base64/);
    expect(() => LocalKeyProvider.fromEnv(`v1:${key(1)},v1:${key(2)}`)).toThrow(/Duplicate/);
  });

  it("fails to unwrap with an unknown key id", async () => {
    const provider = LocalKeyProvider.fromEnv(`v1:${key(1)}`);
    const wrapped = await provider.wrapKey(Buffer.alloc(32), "v1");
    await expect(provider.unwrapKey(wrapped, "v9")).rejects.toBeInstanceOf(DecryptionError);
  });
});
```

`packages/crypto/src/envelope.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { aad } from "./aad";
import { createEncryptor } from "./envelope";
import { DecryptionError } from "./errors";
import { LocalKeyProvider } from "./local-key-provider";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const v1Only = LocalKeyProvider.fromEnv(`v1:${key(1)}`);
const v1AndV2 = LocalKeyProvider.fromEnv(`v1:${key(1)},v2:${key(2)}`);
const v2Only = LocalKeyProvider.fromEnv(`v2:${key(2)}`);
const AAD = aad.aiCredential("user_123", "anthropic");

describe("envelope encryption", () => {
  it("round-trips a string", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("sk-ant-secret-value", AAD);
    expect(await enc.decryptString(blob, AAD)).toBe("sk-ant-secret-value");
  });

  it("round-trips binary data", async () => {
    const enc = createEncryptor(v1Only);
    const data = Buffer.from([0, 1, 2, 255, 254]);
    expect((await enc.decrypt(await enc.encrypt(data, AAD), AAD)).equals(data)).toBe(true);
  });

  it("never contains the plaintext and never repeats ciphertext", async () => {
    const enc = createEncryptor(v1Only);
    const a = await enc.encrypt("same plaintext", AAD);
    const b = await enc.encrypt("same plaintext", AAD);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from("same plaintext"))).toBe(false);
  });

  it("fails with a different associated data (row swap)", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("secret", AAD);
    await expect(enc.decrypt(blob, aad.aiCredential("user_456", "anthropic"))).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("fails when any ciphertext byte is tampered with", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("secret", AAD);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect(enc.decrypt(tampered, AAD)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails on an unknown format version and on truncated input", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("secret", AAD);
    const wrongVersion = Buffer.from(blob);
    wrongVersion[0] = 99;
    await expect(enc.decrypt(wrongVersion, AAD)).rejects.toBeInstanceOf(DecryptionError);
    await expect(enc.decrypt(blob.subarray(0, 10), AAD)).rejects.toBeInstanceOf(DecryptionError);
    await expect(enc.decrypt(Buffer.alloc(0), AAD)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("supports key rotation: old blobs decrypt, new blobs use the newest key", async () => {
    const old = await createEncryptor(v1Only).encrypt("secret", AAD);
    const rotated = createEncryptor(v1AndV2);
    expect(rotated.keyIdOf(old)).toBe("v1");
    expect(await rotated.decryptString(old, AAD)).toBe("secret");
    expect(rotated.keyIdOf(await rotated.encrypt("secret", AAD))).toBe("v2");
  });

  it("fails when the key that wrapped the blob was removed", async () => {
    const old = await createEncryptor(v1Only).encrypt("secret", AAD);
    await expect(createEncryptor(v2Only).decrypt(old, AAD)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("aad helpers", () => {
  it("produce distinct, namespaced strings", () => {
    const values = [
      aad.aiCredential("u1", "anthropic"),
      aad.mailTokens("m1"),
      aad.messageBody("m1"),
      aad.replyDraft("m1"),
      aad.oauthVerifier("m1"),
    ];
    expect(new Set(values).size).toBe(values.length);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @replywise/crypto test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`packages/crypto/src/errors.ts`:
```ts
export class DecryptionError extends Error {
  constructor(message = "Unable to decrypt value") {
    super(message);
    this.name = "DecryptionError";
  }
}
```

`packages/crypto/src/key-provider.ts`:
```ts
/** Holds key-encryption keys (KEKs). Implementations: local (env) and cloud KMS. */
export interface KeyProvider {
  /** Key id used to wrap data keys for new encryptions. */
  readonly currentKeyId: string;
  wrapKey(dataKey: Buffer, keyId: string): Promise<Buffer>;
  /** Must throw DecryptionError when the key id is unknown or the wrapped key is invalid. */
  unwrapKey(wrappedKey: Buffer, keyId: string): Promise<Buffer>;
}
```

`packages/crypto/src/local-key-provider.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptionError } from "./errors";
import type { KeyProvider } from "./key-provider";

const KEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** KEKs supplied via environment. For development, tests and small self-hosted installs. */
export class LocalKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  readonly #keks = new Map<string, Buffer>();

  constructor(keks: ReadonlyArray<{ id: string; key: Buffer }>) {
    for (const { id, key } of keks) {
      if (key.length !== KEK_BYTES) throw new Error(`Key "${id}" must be ${KEK_BYTES} bytes`);
      if (this.#keks.has(id)) throw new Error(`Duplicate key id "${id}"`);
      this.#keks.set(id, key);
    }
    const current = keks.at(-1);
    if (!current) throw new Error("LocalKeyProvider requires at least one key");
    this.currentKeyId = current.id;
  }

  /** Parses `id:base64,id:base64` — the last entry is the current key. */
  static fromEnv(value: string): LocalKeyProvider {
    const keks = value.split(",").map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) throw new Error("LOCAL_KEKS entries must look like id:base64");
      return {
        id: entry.slice(0, separator).trim(),
        key: Buffer.from(entry.slice(separator + 1).trim(), "base64"),
      };
    });
    return new LocalKeyProvider(keks);
  }

  async wrapKey(dataKey: Buffer, keyId: string): Promise<Buffer> {
    const kek = this.#kek(keyId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(Buffer.from(`kek:${keyId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  async unwrapKey(wrappedKey: Buffer, keyId: string): Promise<Buffer> {
    const kek = this.#kek(keyId);
    if (wrappedKey.length <= IV_BYTES + TAG_BYTES) throw new DecryptionError();
    const decipher = createDecipheriv("aes-256-gcm", kek, wrappedKey.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(`kek:${keyId}`, "utf8"));
    decipher.setAuthTag(wrappedKey.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(wrappedKey.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new DecryptionError();
    }
  }

  #kek(keyId: string): Buffer {
    const kek = this.#keks.get(keyId);
    if (!kek) throw new DecryptionError(`Unknown key id "${keyId}"`);
    return kek;
  }
}
```

`packages/crypto/src/envelope.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptionError } from "./errors";
import type { KeyProvider } from "./key-provider";

/**
 * Blob layout:
 * version(1) | keyIdLen(1) | keyId | wrappedDekLen(2, BE) | wrappedDek | iv(12) | tag(16) | ciphertext
 */
const FORMAT_VERSION = 1;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Encryptor {
  encrypt(plaintext: string | Buffer, aad: string): Promise<Buffer>;
  decrypt(blob: Buffer, aad: string): Promise<Buffer>;
  decryptString(blob: Buffer, aad: string): Promise<string>;
  keyIdOf(blob: Buffer): string;
}

interface ParsedBlob {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function parse(blob: Buffer): ParsedBlob {
  const tooShort = () => new DecryptionError("Ciphertext is truncated");
  if (blob.length < 2) throw tooShort();
  let offset = 0;
  const version = blob.readUInt8(offset);
  offset += 1;
  if (version !== FORMAT_VERSION) throw new DecryptionError("Unsupported ciphertext version");
  const keyIdLength = blob.readUInt8(offset);
  offset += 1;
  if (blob.length < offset + keyIdLength + 2) throw tooShort();
  const keyId = blob.subarray(offset, offset + keyIdLength).toString("utf8");
  offset += keyIdLength;
  const wrappedLength = blob.readUInt16BE(offset);
  offset += 2;
  if (blob.length < offset + wrappedLength + IV_BYTES + TAG_BYTES) throw tooShort();
  const wrappedKey = blob.subarray(offset, offset + wrappedLength);
  offset += wrappedLength;
  const iv = blob.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = blob.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  return { keyId, wrappedKey, iv, tag, ciphertext: blob.subarray(offset) };
}

export function createEncryptor(keys: KeyProvider): Encryptor {
  async function decrypt(blob: Buffer, aad: string): Promise<Buffer> {
    const parsed = parse(blob);
    const dataKey = await keys.unwrapKey(parsed.wrappedKey, parsed.keyId);
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, parsed.iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    } catch {
      throw new DecryptionError("Ciphertext authentication failed");
    } finally {
      dataKey.fill(0);
    }
  }

  return {
    async encrypt(plaintext, aad) {
      const dataKey = randomBytes(DEK_BYTES);
      try {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
        cipher.setAAD(Buffer.from(aad, "utf8"));
        const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
        const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
        const tag = cipher.getAuthTag();

        const keyId = keys.currentKeyId;
        const keyIdBytes = Buffer.from(keyId, "utf8");
        if (keyIdBytes.length > 255) throw new Error("Key id is too long");
        const wrappedKey = await keys.wrapKey(dataKey, keyId);
        if (wrappedKey.length > 0xffff) throw new Error("Wrapped key is too long");

        const header = Buffer.alloc(1 + 1 + keyIdBytes.length + 2);
        header.writeUInt8(FORMAT_VERSION, 0);
        header.writeUInt8(keyIdBytes.length, 1);
        keyIdBytes.copy(header, 2);
        header.writeUInt16BE(wrappedKey.length, 2 + keyIdBytes.length);
        return Buffer.concat([header, wrappedKey, iv, tag, ciphertext]);
      } finally {
        dataKey.fill(0);
      }
    },
    decrypt,
    async decryptString(blob, aad) {
      return (await decrypt(blob, aad)).toString("utf8");
    },
    keyIdOf(blob) {
      return parse(blob).keyId;
    },
  };
}
```

`packages/crypto/src/aad.ts`:
```ts
/** Associated-data strings bind each ciphertext to the row and purpose it belongs to. */
export const aad = {
  aiCredential: (userId: string, provider: string) => `ai_credential:${userId}:${provider}`,
  mailTokens: (mailAccountId: string) => `mail_tokens:${mailAccountId}`,
  messageBody: (messageId: string) => `message_body:${messageId}`,
  replyDraft: (draftId: string) => `reply_draft:${draftId}`,
  oauthVerifier: (stateHash: string) => `oauth_verifier:${stateHash}`,
} as const;
```

`packages/crypto/src/index.ts`:
```ts
export * from "./aad";
export * from "./envelope";
export * from "./errors";
export type { KeyProvider } from "./key-provider";
export * from "./local-key-provider";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/crypto test && pnpm --filter @replywise/crypto typecheck`
Expected: 14 tests PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(crypto): add AES-256-GCM envelope encryption with key rotation and AAD"
```

---

### Task 4: `@replywise/observability` — redacting logger

**Files:**
- Create: `packages/observability/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts}` (template, name `@replywise/observability`)
- Create: `packages/observability/src/{logger,index}.ts`
- Test: `packages/observability/src/logger.test.ts`

**Interfaces:**
- Produces: `createLogger(options: { name: string; level?: string }, destination?: DestinationStream): Logger`; `REDACT_PATHS: string[]`; re-exported `type Logger`.

- [ ] **Step 1: Create package**

Template with `"name": "@replywise/observability"`, then:
```bash
pnpm --filter @replywise/observability add pino
pnpm --filter @replywise/observability add -D vitest typescript @types/node
```

- [ ] **Step 2: Write the failing test**

`packages/observability/src/logger.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

function capture() {
  const lines: string[] = [];
  return {
    stream: { write: (chunk: string) => void lines.push(chunk) },
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join(""),
  };
}

describe("createLogger", () => {
  it("redacts secrets at the top level and one level deep", () => {
    const out = capture();
    const logger = createLogger({ name: "test" }, out.stream);
    logger.info(
      {
        apiKey: "sk-ant-top-level",
        credential: { apiKey: "sk-ant-nested", accessToken: "ya29.token", refreshToken: "1//r" },
        headers: { authorization: "Bearer abc", cookie: "session=xyz" },
      },
      "saving credential",
    );
    const raw = out.raw();
    for (const secret of ["sk-ant-top-level", "sk-ant-nested", "ya29.token", "1//r", "Bearer abc", "session=xyz"]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain("[Redacted]");
  });

  it("redacts email content fields", () => {
    const out = capture();
    createLogger({ name: "test" }, out.stream).info(
      { message: { bodyText: "Dear Bob, my SSN is 123", bodyHtml: "<p>secret</p>" }, body: "raw" },
      "synced",
    );
    expect(out.raw()).not.toContain("SSN");
    expect(out.raw()).not.toContain("<p>secret</p>");
  });

  it("keeps non-sensitive fields and tags records with the service name", () => {
    const out = capture();
    createLogger({ name: "worker" }, out.stream).info({ mailAccountId: "abc", purged: 3 }, "done");
    expect(out.records()[0]).toMatchObject({ service: "worker", mailAccountId: "abc", purged: 3, msg: "done" });
  });

  it("respects the log level", () => {
    const out = capture();
    const logger = createLogger({ name: "test", level: "warn" }, out.stream);
    logger.info("hidden");
    logger.warn("shown");
    expect(out.records().map((r) => r.msg)).toEqual(["shown"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @replywise/observability test`
Expected: FAIL — cannot resolve `./logger`.

- [ ] **Step 4: Implement**

`packages/observability/src/logger.ts`:
```ts
import { type DestinationStream, type Logger, pino } from "pino";

const SENSITIVE_KEYS = [
  "password",
  "apiKey",
  "accessToken",
  "refreshToken",
  "idToken",
  "token",
  "codeVerifier",
  "authorization",
  "cookie",
  "body",
  "bodyText",
  "bodyHtml",
] as const;

/**
 * Defense in depth only: redaction covers the top level and one level of nesting.
 * Code must still never pass secrets or email content to the logger.
 */
export const REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
];

export interface CreateLoggerOptions {
  name: string;
  level?: string;
}

export function createLogger(options: CreateLoggerOptions, destination?: DestinationStream): Logger {
  const config = {
    level: options.level ?? "info",
    base: { service: options.name },
    redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(config, destination) : pino(config);
}

export type { Logger };
```

`packages/observability/src/index.ts`:
```ts
export * from "./logger";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/observability test && pnpm --filter @replywise/observability typecheck`
Expected: 4 tests PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(observability): add pino logger with secret and content redaction"
```

---

### Task 5: `@replywise/db` — schema, migrations, maintenance query

**Files:**
- Create: `packages/db/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts,drizzle.config.ts}`
- Create: `packages/db/src/{index,client,columns,migrate,testing}.ts`, `packages/db/src/bin/migrate.ts`
- Create: `packages/db/src/schema/{index,enums,auth,mail,ai,audit}.ts`, `packages/db/src/queries/maintenance.ts`
- Create (generated): `packages/db/migrations/0000_init.sql` + `meta/`
- Test: `packages/db/src/schema.int.test.ts`, `packages/db/src/queries/maintenance.int.test.ts`

**Interfaces:**
- Consumes: `@replywise/core` constants (`MAIL_PROVIDERS`, `INBOX_CATEGORIES`, `REPLY_TONES`, `AI_PROVIDERS`, `AI_TASKS`, `DEFAULT_AI_MODELS`, `EmailAddress`).
- Produces: tables `users, sessions, authAccounts, verifications, mailAccounts, mailOAuthStates, threads, messages, threadInsights, replyDrafts, aiCredentials, userPreferences, aiUsageEvents, auditLogs`; `createDb(url: string, options?: { max?: number }): { db: Db; close(): Promise<void> }`; `type Db`; `runMigrations(url: string, folder?: string): Promise<void>`; `purgeExpiredBodies(db: Db, now?: Date): Promise<number>`; from `@replywise/db/testing`: `TEST_DATABASE_URL`, `setupTestDb(): Promise<{db, close}>`, `resetTestDb(db)`, `insertUser(db, overrides?)`, `insertMailAccount(db, userId, overrides?)`, `insertThread(db, mailAccountId, overrides?)`, `insertMessage(db, threadId, mailAccountId, overrides?)`, `pgErrorCode(error): string | undefined`.

- [ ] **Step 1: Create package and install deps**

`packages/db/package.json`:
```json
{
  "name": "@replywise/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "test:int": "vitest run -c vitest.int.config.ts",
    "generate": "drizzle-kit generate",
    "migrate": "dotenv -e ../../.env -- tsx src/bin/migrate.ts"
  }
}
```
Copy `tsconfig.json`, `vitest.config.ts`, `vitest.int.config.ts` from the template. Then:
```bash
pnpm --filter @replywise/db add drizzle-orm postgres "@replywise/core@workspace:*"
pnpm --filter @replywise/db add -D drizzle-kit tsx dotenv-cli vitest typescript @types/node
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  strict: true,
});
```

- [ ] **Step 2: Schema**

`packages/db/src/columns.ts`:
```ts
import { customType, timestamp } from "drizzle-orm/pg-core";

/** Envelope-encrypted blobs from @replywise/crypto. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
```

`packages/db/src/schema/enums.ts`:
```ts
import { AI_PROVIDERS, AI_TASKS, INBOX_CATEGORIES, MAIL_PROVIDERS, REPLY_TONES } from "@replywise/core";
import { pgEnum } from "drizzle-orm/pg-core";

export const mailProviderEnum = pgEnum("mail_provider", MAIL_PROVIDERS);
export const mailAccountStatusEnum = pgEnum("mail_account_status", ["active", "needs_reauth", "error"]);
export const inboxCategoryEnum = pgEnum("inbox_category", INBOX_CATEGORIES);
export const replyToneEnum = pgEnum("reply_tone", REPLY_TONES);
export const draftStatusEnum = pgEnum("draft_status", ["generated", "edited", "saved", "discarded"]);
export const aiProviderEnum = pgEnum("ai_provider", AI_PROVIDERS);
export const aiTaskEnum = pgEnum("ai_task", AI_TASKS);
export const credentialStatusEnum = pgEnum("credential_status", ["unverified", "valid", "invalid"]);
```

`packages/db/src/schema/auth.ts` (field names match Better Auth's core schema; do not rename the TypeScript keys):
```ts
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "../columns";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Login identities (password, Google sign-in). NOT connected mailboxes — see mail_accounts. */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_accounts_user_idx").on(t.userId)],
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
```

`packages/db/src/schema/mail.ts`:
```ts
import type { EmailAddress } from "@replywise/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, updatedAt } from "../columns";
import { users } from "./auth";
import { mailAccountStatusEnum, mailProviderEnum } from "./enums";

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: mailProviderEnum("provider").notNull(),
    emailAddress: text("email_address").notNull(),
    displayName: text("display_name"),
    status: mailAccountStatusEnum("status").notNull().default("active"),
    grantedScopes: text("granted_scopes").array().notNull().default(sql`'{}'::text[]`),
    /** Encrypted JSON {accessToken, refreshToken, expiresAt}; AAD = aad.mailTokens(id). */
    tokensCiphertext: bytea("tokens_ciphertext").notNull(),
    /** Gmail historyId or Graph deltaLink. */
    syncCursor: text("sync_cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    autoDraftNeedsReply: boolean("auto_draft_needs_reply").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mail_accounts_user_provider_email_uq").on(t.userId, t.provider, t.emailAddress),
  ],
);

export const mailOAuthStates = pgTable("mail_oauth_states", {
  /** SHA-256 of the random state sent to the provider; the raw state is never stored. */
  stateHash: text("state_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: mailProviderEnum("provider").notNull(),
  codeVerifierCiphertext: bytea("code_verifier_ciphertext").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailAccountId: uuid("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    participants: jsonb("participants").$type<EmailAddress[]>().notNull().default(sql`'[]'::jsonb`),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    isUnread: boolean("is_unread").notNull().default(false),
    providerLabels: text("provider_labels").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("threads_account_provider_thread_uq").on(t.mailAccountId, t.providerThreadId),
    index("threads_account_last_message_idx").on(t.mailAccountId, t.lastMessageAt.desc()),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    mailAccountId: uuid("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    internetMessageId: text("internet_message_id"),
    fromAddress: jsonb("from_address").$type<EmailAddress>().notNull(),
    toAddresses: jsonb("to_addresses").$type<EmailAddress[]>().notNull().default(sql`'[]'::jsonb`),
    ccAddresses: jsonb("cc_addresses").$type<EmailAddress[]>().notNull().default(sql`'[]'::jsonb`),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    isFromUser: boolean("is_from_user").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    /** Encrypted body cache; AAD = aad.messageBody(id). Purged at body_expires_at. */
    bodyCiphertext: bytea("body_ciphertext"),
    bodyExpiresAt: timestamp("body_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_account_provider_message_uq").on(t.mailAccountId, t.providerMessageId),
    index("messages_thread_sent_idx").on(t.threadId, t.sentAt),
    index("messages_body_expires_idx").on(t.bodyExpiresAt).where(sql`${t.bodyExpiresAt} is not null`),
  ],
);
```

`packages/db/src/schema/ai.ts`:
```ts
import { DEFAULT_AI_MODELS } from "@replywise/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, updatedAt } from "../columns";
import { users } from "./auth";
import {
  aiProviderEnum,
  aiTaskEnum,
  credentialStatusEnum,
  draftStatusEnum,
  inboxCategoryEnum,
  replyToneEnum,
} from "./enums";
import { mailAccounts, messages, threads } from "./mail";

export const threadInsights = pgTable(
  "thread_insights",
  {
    threadId: uuid("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    category: inboxCategoryEnum("category").notNull(),
    urgency: smallint("urgency").notNull(),
    importance: smallint("importance").notNull(),
    needsReply: boolean("needs_reply").notNull(),
    /** Plain-text explanations shown to the user. */
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    summary: text("summary"),
    summaryThroughMessageId: uuid("summary_through_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    classifiedThroughMessageId: uuid("classified_through_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    aiProvider: aiProviderEnum("ai_provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("thread_insights_category_idx").on(t.category),
    check("thread_insights_urgency_range", sql`${t.urgency} between 1 and 5`),
    check("thread_insights_importance_range", sql`${t.importance} between 1 and 5`),
  ],
);

export const replyDrafts = pgTable(
  "reply_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tone: replyToneEnum("tone").notNull(),
    instructions: text("instructions"),
    /** Encrypted reply text; AAD = aad.replyDraft(id). */
    bodyCiphertext: bytea("body_ciphertext").notNull(),
    status: draftStatusEnum("status").notNull().default("generated"),
    providerDraftId: text("provider_draft_id"),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    aiProvider: aiProviderEnum("ai_provider").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("reply_drafts_thread_created_idx").on(t.threadId, t.createdAt)],
);

export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: aiProviderEnum("provider").notNull(),
    /** Encrypted API key; AAD = aad.aiCredential(userId, provider). */
    keyCiphertext: bytea("key_ciphertext").notNull(),
    /** Last 4 characters, the only part ever shown to the browser. */
    keyHint: text("key_hint").notNull(),
    status: credentialStatusEnum("status").notNull().default("unverified"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ai_credentials_user_provider_uq").on(t.userId, t.provider)],
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    defaultTone: replyToneEnum("default_tone").notNull().default("professional"),
    signature: text("signature").notNull().default(""),
    writingStyleNotes: text("writing_style_notes").notNull().default(""),
    /** null = reply in the language of the email. */
    replyLanguage: text("reply_language"),
    classificationModel: text("classification_model").notNull().default(DEFAULT_AI_MODELS.classification),
    generationModel: text("generation_model").notNull().default(DEFAULT_AI_MODELS.generation),
    bodyCacheDays: smallint("body_cache_days").notNull().default(14),
    updatedAt: updatedAt(),
  },
  (t) => [check("user_preferences_body_cache_days_range", sql`${t.bodyCacheDays} between 1 and 30`)],
);

export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailAccountId: uuid("mail_account_id").references(() => mailAccounts.id, { onDelete: "set null" }),
    task: aiTaskEnum("task").notNull(),
    aiProvider: aiProviderEnum("ai_provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_events_user_created_idx").on(t.userId, t.createdAt)],
);
```

`packages/db/src/schema/audit.ts`:
```ts
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "../columns";
import { users } from "./auth";

/** Never store email content or secrets here. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_user_created_idx").on(t.userId, t.createdAt)],
);
```

`packages/db/src/schema/index.ts`:
```ts
export * from "./ai";
export * from "./audit";
export * from "./auth";
export * from "./enums";
export * from "./mail";
```

- [ ] **Step 3: Client, migrations runner, maintenance query, exports**

`packages/db/src/client.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10 });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
```

`packages/db/src/migrate.ts`:
```ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(url: string, folder: string = MIGRATIONS_FOLDER): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await close();
  }
}
```

`packages/db/src/bin/migrate.ts`:
```ts
import { runMigrations } from "../migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
await runMigrations(url, process.env.MIGRATIONS_FOLDER || undefined);
console.log("migrations applied");
```

`packages/db/src/queries/maintenance.ts`:
```ts
import { and, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../client";
import { messages } from "../schema/mail";

/** Drops cached bodies past their TTL. Returns the number of messages purged. */
export async function purgeExpiredBodies(db: Db, now: Date = new Date()): Promise<number> {
  const purged = await db
    .update(messages)
    .set({ bodyCiphertext: null, bodyExpiresAt: null })
    .where(and(isNotNull(messages.bodyExpiresAt), lte(messages.bodyExpiresAt, now)))
    .returning({ id: messages.id });
  return purged.length;
}
```

`packages/db/src/index.ts`:
```ts
export * from "./client";
export * from "./migrate";
export * from "./queries/maintenance";
export * from "./schema/index";
```

- [ ] **Step 4: Generate the initial migration**

Run: `pnpm db:generate --name init`
Expected: `packages/db/migrations/0000_init.sql` is created. Open it and confirm it contains `CREATE TYPE "public"."inbox_category"`, `CREATE TABLE "mail_accounts"`, the unique index `mail_accounts_user_provider_email_uq`, and the check constraint `thread_insights_urgency_range`.

- [ ] **Step 5: Test helpers**

`packages/db/src/testing.ts`:
```ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, createDb } from "./client";
import { runMigrations } from "./migrate";
import { users } from "./schema/auth";
import { mailAccounts, messages, threads } from "./schema/mail";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgres://replywise:replywise@localhost:5432/replywise_test";

export async function setupTestDb() {
  await runMigrations(TEST_DATABASE_URL);
  return createDb(TEST_DATABASE_URL, { max: 2 });
}

/** Truncating users cascades to every user-owned table. */
export async function resetTestDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table users, audit_logs cascade`);
}

export async function insertUser(db: Db, overrides: Partial<typeof users.$inferInsert> = {}) {
  const id = overrides.id ?? randomUUID();
  const [row] = await db
    .insert(users)
    .values({ id, name: "Test User", email: `${id}@example.com`, ...overrides })
    .returning();
  if (!row) throw new Error("insertUser failed");
  return row;
}

export async function insertMailAccount(
  db: Db,
  userId: string,
  overrides: Partial<typeof mailAccounts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(mailAccounts)
    .values({
      userId,
      provider: "gmail",
      emailAddress: `${randomUUID()}@gmail.com`,
      tokensCiphertext: Buffer.from("not-really-encrypted"),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertMailAccount failed");
  return row;
}

export async function insertThread(
  db: Db,
  mailAccountId: string,
  overrides: Partial<typeof threads.$inferInsert> = {},
) {
  const [row] = await db
    .insert(threads)
    .values({ mailAccountId, providerThreadId: randomUUID(), lastMessageAt: new Date(), ...overrides })
    .returning();
  if (!row) throw new Error("insertThread failed");
  return row;
}

export async function insertMessage(
  db: Db,
  threadId: string,
  mailAccountId: string,
  overrides: Partial<typeof messages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(messages)
    .values({
      threadId,
      mailAccountId,
      providerMessageId: randomUUID(),
      fromAddress: { name: "Sender", address: "sender@example.com" },
      sentAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertMessage failed");
  return row;
}

/** Postgres error code from a driver error, whether or not the ORM wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = typeof current === "object" && current !== null ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}
```

- [ ] **Step 6: Write the failing integration tests**

`packages/db/src/schema.int.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { auditLogs, mailAccounts, messages, threadInsights, threads, users } from "./schema/index";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  pgErrorCode,
  resetTestDb,
  setupTestDb,
} from "./testing";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("mail_accounts", () => {
  it("rejects connecting the same mailbox twice for one user", async () => {
    const user = await insertUser(db);
    await insertMailAccount(db, user.id, { emailAddress: "me@gmail.com" });
    await expect(insertMailAccount(db, user.id, { emailAddress: "me@gmail.com" })).rejects.toSatisfy(
      (error) => pgErrorCode(error) === "23505",
    );
  });

  it("allows the same mailbox address for different users", async () => {
    const a = await insertUser(db);
    const b = await insertUser(db);
    await insertMailAccount(db, a.id, { emailAddress: "shared@gmail.com" });
    await expect(insertMailAccount(db, b.id, { emailAddress: "shared@gmail.com" })).resolves.toBeDefined();
  });

  it("stores encrypted blobs byte-for-byte", async () => {
    const user = await insertUser(db);
    const blob = Buffer.from([1, 0, 255, 128, 7]);
    const account = await insertMailAccount(db, user.id, { tokensCiphertext: blob });
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row?.tokensCiphertext.equals(blob)).toBe(true);
  });
});

describe("deleting a user", () => {
  it("cascades to mailboxes, threads and messages but keeps audit rows", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    await insertMessage(db, thread.id, account.id);
    await db.insert(auditLogs).values({ userId: user.id, action: "mailbox.connected" });

    await db.delete(users).where(eq(users.id, user.id));

    expect(await db.select().from(mailAccounts)).toHaveLength(0);
    expect(await db.select().from(threads)).toHaveLength(0);
    expect(await db.select().from(messages)).toHaveLength(0);
    const audit = await db.select().from(auditLogs);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.userId).toBeNull();
  });
});

describe("thread_insights", () => {
  it("enforces the 1-5 urgency range", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    const message = await insertMessage(db, thread.id, account.id);
    await expect(
      db.insert(threadInsights).values({
        threadId: thread.id,
        category: "urgent",
        urgency: 7,
        importance: 3,
        needsReply: true,
        reasons: ["Deadline today"],
        classifiedThroughMessageId: message.id,
        aiProvider: "anthropic",
        model: "claude-opus-5-5",
        promptVersion: "test",
      }),
    ).rejects.toSatisfy((error) => pgErrorCode(error) === "23514");
  });
});
```

`packages/db/src/queries/maintenance.int.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { messages } from "../schema/mail";
import { insertMailAccount, insertMessage, insertThread, insertUser, resetTestDb, setupTestDb } from "../testing";
import { purgeExpiredBodies } from "./maintenance";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("purgeExpiredBodies", () => {
  it("clears only bodies whose TTL has passed", async () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    const expired = await insertMessage(db, thread.id, account.id, {
      bodyCiphertext: Buffer.from("old"),
      bodyExpiresAt: new Date("2026-11-15T11:59:59Z"),
    });
    const fresh = await insertMessage(db, thread.id, account.id, {
      bodyCiphertext: Buffer.from("new"),
      bodyExpiresAt: new Date("2026-11-16T00:00:00Z"),
    });

    expect(await purgeExpiredBodies(db, now)).toBe(1);

    const [expiredRow] = await db.select().from(messages).where(eq(messages.id, expired.id));
    const [freshRow] = await db.select().from(messages).where(eq(messages.id, fresh.id));
    expect(expiredRow?.bodyCiphertext).toBeNull();
    expect(expiredRow?.bodyExpiresAt).toBeNull();
    expect(freshRow?.bodyCiphertext?.toString()).toBe("new");
  });

  it("returns 0 when nothing is expired", async () => {
    expect(await purgeExpiredBodies(db)).toBe(0);
  });
});
```

- [ ] **Step 7: Run integration tests**

Run: `docker compose up -d --wait && pnpm --filter @replywise/db test:int`
Expected: 7 tests PASS. (If any fail, the schema or helpers are wrong — fix them; do not loosen the assertions.)

- [ ] **Step 8: Apply migrations to the dev database and typecheck**

Run: `cp -n .env.example .env` (fill `LOCAL_KEKS` and `BETTER_AUTH_SECRET` using the commands in the file), then `pnpm db:migrate && pnpm --filter @replywise/db typecheck`
Expected: `migrations applied`; typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(db): add Drizzle schema, initial migration and body purge query"
```

---

### Task 6: `@replywise/queue` — typed jobs on BullMQ

**Files:**
- Create: `packages/queue/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts}` (template, name `@replywise/queue`)
- Create: `packages/queue/src/{jobs,bullmq,index}.ts`
- Test: `packages/queue/src/bullmq.int.test.ts`

**Interfaces:**
- Produces: `type QueueName = "sync" | "ai" | "maintenance"`; `jobDefinitions` (M1: `"maintenance.purgeBodies"` → queue `maintenance`, payload `{}`); `type JobName`; `type JobPayload<N>`; `interface JobQueue { enqueue(name, payload, options?: { jobId?: string; delayMs?: number }): Promise<void>; scheduleRepeating(schedulerId, name, payload, everyMs: number): Promise<void>; close(): Promise<void> }`; `createRedisConnection(url: string): Redis`; `createJobQueue(connection: Redis, options?: { prefix?: string }): JobQueue`; `type JobHandlers` (one handler per job name: `(payload, ctx: { jobId: string | undefined; attempt: number }) => Promise<void>`); `createJobWorker(queue: QueueName, connection: Redis, handlers: Partial<JobHandlers>, options?: { concurrency?: number; prefix?: string }): Worker`.

- [ ] **Step 1: Create package**

Template with `"name": "@replywise/queue"`, then:
```bash
pnpm --filter @replywise/queue add bullmq ioredis zod
pnpm --filter @replywise/queue add -D vitest typescript @types/node
```

- [ ] **Step 2: Write the failing integration test**

`packages/queue/src/bullmq.int.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobQueue, createJobWorker, createRedisConnection } from "./bullmq";

const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6379";

let prefix: string;
let connections: Redis[];
const closers: Array<() => Promise<unknown>> = [];

function connection() {
  const c = createRedisConnection(REDIS_URL);
  connections.push(c);
  return c;
}

beforeEach(() => {
  prefix = `test-${randomUUID()}`;
  connections = [];
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(connections.map((c) => c.quit()));
});

describe("BullMQ job queue", () => {
  it("delivers a validated payload to the matching handler", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());

    const received = new Promise<unknown>((resolve) => {
      const worker = createJobWorker(
        "maintenance",
        connection(),
        { "maintenance.purgeBodies": async (payload) => resolve(payload) },
        { prefix },
      );
      closers.push(() => worker.close());
    });

    await queue.enqueue("maintenance.purgeBodies", {});
    await expect(received).resolves.toEqual({});
  });

  it("rejects an invalid payload at enqueue time", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await expect(
      queue.enqueue("maintenance.purgeBodies", { unexpected: true } as never),
    ).rejects.toThrow();
  });

  it("deduplicates jobs that share a jobId", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await queue.enqueue("maintenance.purgeBodies", {}, { jobId: "purge-once" });
    await queue.enqueue("maintenance.purgeBodies", {}, { jobId: "purge-once" });

    const inspector = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => inspector.close());
    expect((await inspector.getJobCounts("waiting")).waiting).toBe(1);
  });

  it("fails unknown job names without retrying", async () => {
    const raw = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => raw.close());

    const failure = new Promise<{ message: string; attempts: number }>((resolve) => {
      const worker = createJobWorker("maintenance", connection(), {}, { prefix });
      worker.on("failed", (job, error) => resolve({ message: error.message, attempts: job?.attemptsMade ?? -1 }));
      closers.push(() => worker.close());
    });

    await raw.add("maintenance.doesNotExist", {}, { attempts: 3 });
    const result = await failure;
    expect(result.message).toMatch(/Unknown job/);
    expect(result.attempts).toBe(1);
  });

  it("registers a repeating scheduler idempotently", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await queue.scheduleRepeating("purge-hourly", "maintenance.purgeBodies", {}, 3_600_000);
    await queue.scheduleRepeating("purge-hourly", "maintenance.purgeBodies", {}, 3_600_000);

    const inspector = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => inspector.close());
    const schedulers = await inspector.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual(["purge-hourly"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @replywise/queue test:int`
Expected: FAIL — cannot resolve `./bullmq`.

- [ ] **Step 4: Implement**

`packages/queue/src/jobs.ts`:
```ts
import { z } from "zod";

export type QueueName = "sync" | "ai" | "maintenance";

/** Single source of truth for job names, their queue, and payload shape. Payloads carry ids only. */
export const jobDefinitions = {
  "maintenance.purgeBodies": { queue: "maintenance", payload: z.object({}).strict() },
} as const satisfies Record<string, { queue: QueueName; payload: z.ZodType }>;

export type JobName = keyof typeof jobDefinitions;
export type JobPayload<N extends JobName> = z.output<(typeof jobDefinitions)[N]["payload"]>;

export interface JobContext {
  jobId: string | undefined;
  attempt: number;
}

export type JobHandlers = {
  [N in JobName]: (payload: JobPayload<N>, context: JobContext) => Promise<void>;
};

export interface EnqueueOptions {
  /** Jobs with the same id are deduplicated while one is pending. */
  jobId?: string;
  delayMs?: number;
}

export interface JobQueue {
  enqueue<N extends JobName>(name: N, payload: JobPayload<N>, options?: EnqueueOptions): Promise<void>;
  scheduleRepeating<N extends JobName>(
    schedulerId: string,
    name: N,
    payload: JobPayload<N>,
    everyMs: number,
  ): Promise<void>;
  close(): Promise<void>;
}

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(jobDefinitions, name);
}
```

`packages/queue/src/bullmq.ts`:
```ts
import { type Job, Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  type JobContext,
  type JobHandlers,
  type JobQueue,
  type QueueName,
  isJobName,
  jobDefinitions,
} from "./jobs";

const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** BullMQ requires maxRetriesPerRequest: null for blocking worker connections. */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createJobQueue(connection: Redis, options: { prefix?: string } = {}): JobQueue {
  const queues = new Map<QueueName, Queue>();
  const queueFor = (name: QueueName): Queue => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
        ...(options.prefix ? { prefix: options.prefix } : {}),
      });
      queues.set(name, queue);
    }
    return queue;
  };

  return {
    async enqueue(name, payload, enqueueOptions = {}) {
      const definition = jobDefinitions[name];
      const data = definition.payload.parse(payload);
      await queueFor(definition.queue).add(name, data, {
        ...(enqueueOptions.jobId ? { jobId: enqueueOptions.jobId } : {}),
        ...(enqueueOptions.delayMs ? { delay: enqueueOptions.delayMs } : {}),
      });
    },
    async scheduleRepeating(schedulerId, name, payload, everyMs) {
      const definition = jobDefinitions[name];
      await queueFor(definition.queue).upsertJobScheduler(
        schedulerId,
        { every: everyMs },
        { name, data: definition.payload.parse(payload) },
      );
    },
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
    },
  };
}

export function createJobWorker(
  queue: QueueName,
  connection: Redis,
  handlers: Partial<JobHandlers>,
  options: { concurrency?: number; prefix?: string } = {},
): Worker {
  return new Worker(
    queue,
    async (job: Job) => {
      if (!isJobName(job.name) || jobDefinitions[job.name].queue !== queue) {
        throw new UnrecoverableError(`Unknown job "${job.name}" on queue "${queue}"`);
      }
      const handler = handlers[job.name] as
        | ((payload: unknown, context: JobContext) => Promise<void>)
        | undefined;
      if (!handler) throw new UnrecoverableError(`No handler registered for "${job.name}"`);
      const parsed = jobDefinitions[job.name].payload.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError(`Invalid payload for "${job.name}"`);
      await handler(parsed.data, { jobId: job.id, attempt: job.attemptsMade + 1 });
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );
}
```

`packages/queue/src/index.ts`:
```ts
export * from "./bullmq";
export * from "./jobs";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/queue test:int && pnpm --filter @replywise/queue typecheck`
Expected: 5 tests PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(queue): add typed BullMQ job queue and worker factory"
```

---

### Task 7: Worker app with the body-purge maintenance job

**Files:**
- Create: `apps/worker/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts,tsup.config.ts}`
- Create: `apps/worker/src/{env,main,index}.ts`, `apps/worker/src/jobs/purge-bodies.ts`
- Test: `apps/worker/src/main.int.test.ts`

**Interfaces:**
- Consumes: `parseEnv`, `workerEnvSchema`, `WorkerEnv` (config); `createLogger`, `Logger` (observability); `createDb`, `purgeExpiredBodies`, `Db` (db); `createJobQueue`, `createJobWorker`, `createRedisConnection` (queue).
- Produces: `startWorker(env: WorkerEnv, logger: Logger, options?: { queuePrefix?: string }): Promise<{ stop(): Promise<void> }>`; `purgeBodiesHandler(deps: { db: Db; logger: Logger; now?: () => Date }): () => Promise<void>`; `PURGE_BODIES_SCHEDULER_ID = "maintenance.purgeBodies:hourly"`.

- [ ] **Step 1: Create package**

`apps/worker/package.json`:
```json
{
  "name": "@replywise/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "dotenv -e ../../.env -- tsx watch src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "test:int": "vitest run -c vitest.int.config.ts"
  }
}
```
Copy `tsconfig.json`, `vitest.config.ts`, `vitest.int.config.ts` from the template. Then:
```bash
pnpm --filter @replywise/worker add "@replywise/config@workspace:*" "@replywise/db@workspace:*" "@replywise/observability@workspace:*" "@replywise/queue@workspace:*" bullmq ioredis pino postgres drizzle-orm
pnpm --filter @replywise/worker add -D tsx tsup dotenv-cli vitest typescript @types/node
```

`apps/worker/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", migrate: "../../packages/db/src/bin/migrate.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@replywise\//],
  clean: true,
  sourcemap: true,
});
```

- [ ] **Step 2: Write the failing integration test**

`apps/worker/src/main.int.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { messages } from "@replywise/db";
import {
  TEST_DATABASE_URL,
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "@replywise/db/testing";
import { createLogger } from "@replywise/observability";
import { createRedisConnection } from "@replywise/queue";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeBodiesHandler } from "./jobs/purge-bodies";
import { PURGE_BODIES_SCHEDULER_ID, startWorker } from "./main";

const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6379";
const silentLogger = () => {
  const lines: string[] = [];
  return { logger: createLogger({ name: "test" }, { write: (l: string) => void lines.push(l) }), lines };
};

let handle: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  handle = await setupTestDb();
});
afterAll(async () => handle.close());
beforeEach(async () => resetTestDb(handle.db));

describe("purgeBodiesHandler", () => {
  it("purges expired bodies and logs only the count", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const thread = await insertThread(db, account.id);
    const message = await insertMessage(db, thread.id, account.id, {
      bodyCiphertext: Buffer.from("confidential body"),
      bodyExpiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    const { logger, lines } = silentLogger();

    await purgeBodiesHandler({ db, logger, now: () => new Date("2026-11-15T00:00:00Z") })();

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(row?.bodyCiphertext).toBeNull();
    expect(lines.join("")).toContain('"purged":1');
    expect(lines.join("")).not.toContain("confidential body");
  });
});

describe("startWorker", () => {
  it("registers the hourly purge scheduler and stops cleanly", async () => {
    const queuePrefix = `test-${randomUUID()}`;
    const { logger } = silentLogger();
    const worker = await startWorker(
      {
        NODE_ENV: "test",
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL,
        LOCAL_KEKS: `v1:${Buffer.alloc(32).toString("base64")}`,
        LOG_LEVEL: "info",
      },
      logger,
      { queuePrefix },
    );

    const connection = createRedisConnection(REDIS_URL);
    const inspector = new Queue("maintenance", { connection, prefix: queuePrefix });
    try {
      const schedulers = await inspector.getJobSchedulers();
      expect(schedulers.map((s) => s.key)).toContain(PURGE_BODIES_SCHEDULER_ID);
    } finally {
      await inspector.close();
      await connection.quit();
      await worker.stop();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @replywise/worker test:int`
Expected: FAIL — cannot resolve `./jobs/purge-bodies` / `./main`.

- [ ] **Step 4: Implement**

`apps/worker/src/jobs/purge-bodies.ts`:
```ts
import { type Db, purgeExpiredBodies } from "@replywise/db";
import type { Logger } from "@replywise/observability";

export function purgeBodiesHandler(deps: { db: Db; logger: Logger; now?: () => Date }) {
  return async (): Promise<void> => {
    const now = deps.now?.() ?? new Date();
    const purged = await purgeExpiredBodies(deps.db, now);
    deps.logger.info({ purged }, "purged expired message bodies");
  };
}
```

`apps/worker/src/main.ts`:
```ts
import type { WorkerEnv } from "@replywise/config";
import { createDb } from "@replywise/db";
import type { Logger } from "@replywise/observability";
import { createJobQueue, createJobWorker, createRedisConnection } from "@replywise/queue";
import { purgeBodiesHandler } from "./jobs/purge-bodies";

export const PURGE_BODIES_SCHEDULER_ID = "maintenance.purgeBodies:hourly";
const ONE_HOUR_MS = 60 * 60 * 1000;

export async function startWorker(
  env: WorkerEnv,
  logger: Logger,
  options: { queuePrefix?: string } = {},
) {
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  const queueConnection = createRedisConnection(env.REDIS_URL);
  const workerConnection = createRedisConnection(env.REDIS_URL);
  const prefix = options.queuePrefix ? { prefix: options.queuePrefix } : {};

  const queue = createJobQueue(queueConnection, prefix);
  const maintenanceWorker = createJobWorker(
    "maintenance",
    workerConnection,
    { "maintenance.purgeBodies": purgeBodiesHandler({ db, logger }) },
    { concurrency: 1, ...prefix },
  );
  maintenanceWorker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, error: { name: error.name, message: error.message } },
      "job failed",
    );
  });

  await queue.scheduleRepeating(PURGE_BODIES_SCHEDULER_ID, "maintenance.purgeBodies", {}, ONE_HOUR_MS);
  logger.info("worker started");

  return {
    async stop(): Promise<void> {
      await maintenanceWorker.close();
      await queue.close();
      await Promise.all([queueConnection.quit(), workerConnection.quit()]);
      await closeDb();
      logger.info("worker stopped");
    },
  };
}
```

`apps/worker/src/env.ts`:
```ts
import { parseEnv, workerEnvSchema } from "@replywise/config";

export const env = parseEnv(workerEnvSchema, process.env);
```

`apps/worker/src/index.ts`:
```ts
import { createLogger } from "@replywise/observability";
import { env } from "./env";
import { startWorker } from "./main";

const logger = createLogger({ name: "worker", level: env.LOG_LEVEL });
const worker = await startWorker(env, logger);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  try {
    await worker.stop();
    process.exit(0);
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

- [ ] **Step 5: Run tests, build, smoke run**

Run: `pnpm --filter @replywise/worker test:int && pnpm --filter @replywise/worker typecheck && pnpm --filter @replywise/worker build`
Expected: 2 tests PASS; typecheck exit 0; `apps/worker/dist/index.js` and `dist/migrate.js` exist.

Run: `pnpm --filter @replywise/worker dev`, wait for the `worker started` log line, press Ctrl+C.
Expected: `shutting down` then `worker stopped`, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): add worker process with hourly encrypted-body purge"
```

---

### Task 8: Web app shell — theme, layout, navigation, security headers

**Files:**
- Create (generator): `apps/web/**` via create-next-app, then shadcn components under `apps/web/src/components/ui/`
- Create: `apps/web/{vitest.config.ts,vitest.setup.ts}`, `apps/web/src/lib/security-headers.ts`
- Create: `apps/web/src/components/{theme-provider,theme-toggle,theme-selector}.tsx`
- Create: `apps/web/src/components/app-shell/{nav-items.ts,nav-links.tsx,sidebar-content.tsx,mobile-nav.tsx,app-shell.tsx}`
- Create: `apps/web/src/components/inbox/empty-inbox.tsx`
- Create: `apps/web/src/app/(app)/{layout,inbox/page,inbox/[category]/page,settings/page}.tsx`
- Modify: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`
- Test: `apps/web/src/lib/security-headers.test.ts`, `apps/web/src/components/app-shell/nav-items.test.ts`, `apps/web/src/components/app-shell/nav-links.test.tsx`

**Interfaces:**
- Consumes: `INBOX_CATEGORIES`, `CATEGORY_META`, `categoryFromSlug`, `InboxCategory` (core).
- Produces: `AppShell({ children, accountSlot?: ReactNode })` — Task 9 passes the user menu as `accountSlot`; `securityHeaders(isProduction: boolean): {key: string; value: string}[]`; `buildNavItems(): NavItem[]`, `SETTINGS_NAV_ITEM`, `isActive(pathname, href)`.

- [ ] **Step 1: Generate the Next.js app**

Run from the repo root:
```bash
pnpm create next-app@latest apps/web --ts --tailwind --app --src-dir --import-alias "@/*" --use-pnpm --skip-install --disable-git --turbopack
```
If prompted: TypeScript yes, linter **none** (Biome covers it), Tailwind yes, `src/` yes, App Router yes, Turbopack yes, alias `@/*`. Delete any generated ESLint config (`eslint.config.*`) and ESLint devDependencies, and delete `apps/web/.gitignore` if created (root ignore covers it).

Edit `apps/web/package.json`: set `"name": "@replywise/web"`, `"private": true`, and the scripts:
```json
"scripts": {
  "dev": "dotenv -e ../../.env -- next dev --turbopack",
  "build": "next build",
  "start": "dotenv -e ../../.env -- next start",
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "test": "vitest run",
  "e2e": "dotenv -e ../../.env -- playwright test"
}
```
In `apps/web/tsconfig.json` add `"noUncheckedIndexedAccess": true` under `compilerOptions`.

Run:
```bash
pnpm --filter @replywise/web add "@replywise/core@workspace:*" next-themes lucide-react
pnpm --filter @replywise/web add -D dotenv-cli vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
pnpm install
cd apps/web && pnpm dlx shadcn@latest init --base-color neutral && pnpm dlx shadcn@latest add button dropdown-menu sheet input label card separator && cd ../..
```
Expected: `apps/web/src/components/ui/*.tsx`, `apps/web/src/lib/utils.ts` (exports `cn`) and theme CSS variables in `apps/web/src/app/globals.css` exist.

- [ ] **Step 2: Vitest setup**

`apps/web/vitest.config.ts`:
```ts
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

`apps/web/vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
```

- [ ] **Step 3: Write the failing tests**

`apps/web/src/lib/security-headers.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { securityHeaders } from "./security-headers";

const asMap = (isProduction: boolean) =>
  Object.fromEntries(securityHeaders(isProduction).map((h) => [h.key, h.value]));

describe("securityHeaders", () => {
  it("forbids framing and MIME sniffing in every environment", () => {
    for (const headers of [asMap(true), asMap(false)]) {
      expect(headers["X-Frame-Options"]).toBe("DENY");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
      expect(headers["Content-Security-Policy"]).toContain("object-src 'none'");
    }
  });

  it("only allows eval and enables HSTS where appropriate", () => {
    expect(asMap(false)["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(asMap(true)["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
    expect(asMap(true)["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(asMap(false)["Strict-Transport-Security"]).toBeUndefined();
  });
});
```

`apps/web/src/components/app-shell/nav-items.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildNavItems, isActive } from "./nav-items";

describe("buildNavItems", () => {
  it("lists all mail followed by every category in precedence order", () => {
    expect(buildNavItems().map((i) => [i.label, i.href])).toEqual([
      ["All mail", "/inbox"],
      ["Urgent", "/inbox/urgent"],
      ["Important", "/inbox/important"],
      ["Needs Reply", "/inbox/needs-reply"],
      ["Informational", "/inbox/informational"],
      ["Low Priority", "/inbox/low-priority"],
    ]);
  });
});

describe("isActive", () => {
  it("matches All mail only on /inbox exactly", () => {
    expect(isActive("/inbox", "/inbox")).toBe(true);
    expect(isActive("/inbox/urgent", "/inbox")).toBe(false);
  });

  it("matches a section and its children", () => {
    expect(isActive("/inbox/urgent", "/inbox/urgent")).toBe(true);
    expect(isActive("/settings/mailboxes", "/settings")).toBe(true);
    expect(isActive("/inbox/urgent-ish", "/inbox/urgent")).toBe(false);
  });
});
```

`apps/web/src/components/app-shell/nav-links.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NavLinks } from "./nav-links";
import { buildNavItems } from "./nav-items";

vi.mock("next/navigation", () => ({ usePathname: () => "/inbox/needs-reply" }));

describe("NavLinks", () => {
  it("marks only the current view as the current page", () => {
    render(<NavLinks items={buildNavItems()} label="Mailbox views" />);
    expect(screen.getByRole("link", { name: "Needs Reply" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "All mail" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("navigation", { name: "Mailbox views" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @replywise/web test`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement headers and navigation**

`apps/web/src/lib/security-headers.ts`:
```ts
export interface Header {
  key: string;
  value: string;
}

function contentSecurityPolicy(isProduction: boolean): string {
  return [
    "default-src 'self'",
    // Nonce-based script-src arrives in M6; Next.js and next-themes need inline scripts today.
    `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isProduction ? "" : " ws: wss:"}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function securityHeaders(isProduction: boolean): Header[] {
  const headers: Header[] = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isProduction) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  ];
  if (isProduction) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" });
  }
  return headers;
}
```

`apps/web/next.config.ts`:
```ts
import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: [
    "@replywise/core",
    "@replywise/config",
    "@replywise/crypto",
    "@replywise/db",
    "@replywise/observability",
  ],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "production") }];
  },
};

export default nextConfig;
```

`apps/web/src/components/app-shell/nav-items.ts`:
```ts
import { CATEGORY_META, INBOX_CATEGORIES, type InboxCategory } from "@replywise/core";

export type NavIcon = "inbox" | "settings" | InboxCategory;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

export function buildNavItems(): NavItem[] {
  return [
    { href: "/inbox", label: "All mail", icon: "inbox" },
    ...INBOX_CATEGORIES.map((category) => ({
      href: `/inbox/${CATEGORY_META[category].slug}`,
      label: CATEGORY_META[category].label,
      icon: category,
    })),
  ];
}

export const SETTINGS_NAV_ITEM: NavItem = { href: "/settings", label: "Settings", icon: "settings" };

export function isActive(pathname: string, href: string): boolean {
  if (href === "/inbox") return pathname === "/inbox";
  return pathname === href || pathname.startsWith(`${href}/`);
}
```

`apps/web/src/components/app-shell/nav-links.tsx`:
```tsx
"use client";

import { cn } from "@/lib/utils";
import {
  BellOff,
  Flame,
  Inbox,
  Info,
  type LucideIcon,
  Reply,
  Settings,
  Star,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type NavIcon, type NavItem, isActive } from "./nav-items";

const ICONS: Record<NavIcon, LucideIcon> = {
  inbox: Inbox,
  settings: Settings,
  urgent: Flame,
  important: Star,
  needs_reply: Reply,
  informational: Info,
  low_priority: BellOff,
};

export function NavLinks({
  items,
  label,
  onNavigate,
}: {
  items: NavItem[];
  label: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-accent font-medium text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @replywise/web test`
Expected: 6 tests PASS.

- [ ] **Step 7: Theme and shell components**

`apps/web/src/components/theme-provider.tsx`:
```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props} />;
}
```

`apps/web/src/components/theme-toggle.tsx`:
```tsx
"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          <Sun className="size-4 dark:hidden" aria-hidden />
          <Moon className="hidden size-4 dark:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setTheme("light")}>
          <Sun aria-hidden /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme("dark")}>
          <Moon aria-hidden /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme("system")}>
          <Monitor aria-hidden /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

`apps/web/src/components/theme-selector.tsx`:
```tsx
"use client";

import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div role="group" aria-label="Theme" className="inline-flex gap-1 rounded-lg border border-border p-1">
      {OPTIONS.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={mounted && theme === option.value ? "secondary" : "ghost"}
          aria-pressed={mounted && theme === option.value}
          onClick={() => setTheme(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
```

`apps/web/src/components/app-shell/sidebar-content.tsx`:
```tsx
"use client";

import { ThemeToggle } from "@/components/theme-toggle";
import Link from "next/link";
import type { ReactNode } from "react";
import { NavLinks } from "./nav-links";
import { SETTINGS_NAV_ITEM, buildNavItems } from "./nav-items";

export function SidebarContent({
  accountSlot,
  onNavigate,
}: {
  accountSlot?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6">
      <Link
        href="/inbox"
        onClick={onNavigate}
        className="flex items-center gap-2 px-2.5 text-sm font-semibold tracking-tight"
      >
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded-md bg-foreground text-xs font-bold text-background"
        >
          R
        </span>
        Replywise
      </Link>
      <NavLinks items={buildNavItems()} label="Mailbox views" onNavigate={onNavigate} />
      <div className="mt-auto flex flex-col gap-2">
        <NavLinks items={[SETTINGS_NAV_ITEM]} label="Account" onNavigate={onNavigate} />
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0 flex-1">{accountSlot}</div>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/components/app-shell/mobile-nav.tsx`:
```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Menu } from "lucide-react";
import { type ReactNode, useState } from "react";
import { SidebarContent } from "./sidebar-content";

export function MobileNav({ accountSlot }: { accountSlot?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open navigation">
          <Menu className="size-4" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 px-3 py-4">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarContent accountSlot={accountSlot} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
```

`apps/web/src/components/app-shell/app-shell.tsx`:
```tsx
import type { ReactNode } from "react";
import { MobileNav } from "./mobile-nav";
import { SidebarContent } from "./sidebar-content";

export function AppShell({ children, accountSlot }: { children: ReactNode; accountSlot?: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-sidebar px-3 py-4 md:flex">
        <SidebarContent accountSlot={accountSlot} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-border px-3 md:hidden">
          <MobileNav accountSlot={accountSlot} />
          <span className="text-sm font-semibold tracking-tight">Replywise</span>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
```

`apps/web/src/components/inbox/empty-inbox.tsx`:
```tsx
import { Inbox } from "lucide-react";

export function EmptyInbox({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="text-base font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
```

- [ ] **Step 8: Pages and layouts**

`apps/web/src/app/layout.tsx` (keep the Geist font imports create-next-app generated; the essential parts are below):
```tsx
import { ThemeProvider } from "@/components/theme-provider";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Replywise", template: "%s · Replywise" },
  description: "Your inbox, triaged. Replies drafted. Nothing sent without you.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

`apps/web/src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/inbox");
}
```

`apps/web/src/app/(app)/layout.tsx` (Task 9 adds the session check):
```tsx
import { AppShell } from "@/components/app-shell/app-shell";
import type { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
```

`apps/web/src/app/(app)/inbox/page.tsx`:
```tsx
import { EmptyInbox } from "@/components/inbox/empty-inbox";

export const metadata = { title: "All mail" };

export default function InboxPage() {
  return (
    <EmptyInbox
      title="No mailboxes connected"
      description="Connect Gmail or Outlook and Replywise will sort new mail into Urgent, Important, Needs Reply, Informational and Low Priority."
    />
  );
}
```

`apps/web/src/app/(app)/inbox/[category]/page.tsx`:
```tsx
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { CATEGORY_META, categoryFromSlug } from "@replywise/core";
import { notFound } from "next/navigation";

type Props = { params: Promise<{ category: string }> };

export async function generateMetadata({ params }: Props) {
  const category = categoryFromSlug((await params).category);
  return { title: category ? CATEGORY_META[category].label : "Not found" };
}

export default async function CategoryPage({ params }: Props) {
  const category = categoryFromSlug((await params).category);
  if (!category) notFound();
  const meta = CATEGORY_META[category];
  return <EmptyInbox title={`Nothing in ${meta.label}`} description={meta.description} />;
}
```

`apps/web/src/app/(app)/settings/page.tsx`:
```tsx
import { ThemeSelector } from "@/components/theme-selector";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <section className="mt-8 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">Appearance</h2>
          <p className="text-sm text-muted-foreground">Choose light, dark, or follow your system.</p>
        </div>
        <ThemeSelector />
      </section>
    </div>
  );
}
```

- [ ] **Step 9: Verify**

Run: `pnpm --filter @replywise/web test && pnpm --filter @replywise/web typecheck && pnpm lint && pnpm --filter @replywise/web build`
Expected: tests PASS, typecheck/lint exit 0, build succeeds (`.next/standalone` exists).

Run `pnpm --filter @replywise/web dev` and check in a browser at http://localhost:3000: redirect to `/inbox`, sidebar at ≥768px, hamburger sheet below 768px, theme toggle switches light/dark, `/inbox/needs-reply` highlights "Needs Reply", `/inbox/bogus` shows 404.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): add themed responsive app shell, category navigation and security headers"
```

---

### Task 9: App authentication (Better Auth) and protected routes

**Files:**
- Create: `apps/web/src/lib/{env,db,auth,auth-client,initials}.ts`
- Create: `apps/web/src/app/api/auth/[...all]/route.ts`
- Create: `apps/web/src/app/(auth)/{layout,sign-in/page,sign-up/page}.tsx`
- Create: `apps/web/src/components/auth/{sign-in-form,sign-up-form}.tsx`, `apps/web/src/components/app-shell/user-menu.tsx`
- Create: `apps/web/playwright.config.ts`
- Modify: `apps/web/src/app/(app)/layout.tsx`, `apps/web/next.config.ts` (no change needed if Task 8 listed packages), `apps/web/package.json`
- Test: `apps/web/src/lib/initials.test.ts`, `apps/web/e2e/auth.spec.ts`

**Interfaces:**
- Consumes: `parseEnv`, `webEnvSchema`, `WebEnv` (config); `createDb`, `Db`, `users`, `sessions`, `authAccounts`, `verifications` (db); `AppShell({ accountSlot })` (Task 8).
- Produces: `getEnv(): WebEnv`; `getDb(): Db`; `getAuth()`; `getSession(): Promise<Session | null>`; `requireSession(): Promise<Session>` (redirects to `/sign-in`); `authClient`; `initialsFor(name: string): string`.

- [ ] **Step 1: Install**

```bash
pnpm --filter @replywise/web add better-auth server-only "@replywise/config@workspace:*" "@replywise/db@workspace:*"
pnpm --filter @replywise/web add -D @playwright/test
pnpm --filter @replywise/web exec playwright install chromium
```

- [ ] **Step 2: Write the failing unit test**

`apps/web/src/lib/initials.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { initialsFor } from "./initials";

describe("initialsFor", () => {
  it("uses the first letters of the first and last words", () => {
    expect(initialsFor("Ada Lovelace")).toBe("AL");
    expect(initialsFor("  grace   brewster murray hopper ")).toBe("GH");
  });

  it("handles single names and empty input", () => {
    expect(initialsFor("Linus")).toBe("L");
    expect(initialsFor("   ")).toBe("?");
  });
});
```

Run: `pnpm --filter @replywise/web test`
Expected: FAIL — cannot resolve `./initials`.

- [ ] **Step 3: Implement server-side auth wiring**

`apps/web/src/lib/initials.ts`:
```ts
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0];
  if (!first) return "?";
  const last = words.length > 1 ? words.at(-1)?.[0] : undefined;
  return `${first}${last ?? ""}`.toUpperCase();
}
```

`apps/web/src/lib/env.ts`:
```ts
import "server-only";
import { type WebEnv, parseEnv, webEnvSchema } from "@replywise/config";

let cached: WebEnv | undefined;

/** Parsed lazily so `next build` does not require runtime secrets. */
export function getEnv(): WebEnv {
  cached ??= parseEnv(webEnvSchema, process.env);
  return cached;
}
```

`apps/web/src/lib/db.ts`:
```ts
import "server-only";
import { type Db, createDb } from "@replywise/db";
import { getEnv } from "./env";

const globalForDb = globalThis as unknown as { replywiseDb?: Db };

/** One pool per process; survives dev hot reloads. */
export function getDb(): Db {
  globalForDb.replywiseDb ??= createDb(getEnv().DATABASE_URL).db;
  return globalForDb.replywiseDb;
}
```

`apps/web/src/lib/auth.ts`:
```ts
import "server-only";
import { authAccounts, sessions, users, verifications } from "@replywise/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "./db";
import { getEnv } from "./env";

function createAuth() {
  const env = getEnv();
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {};

  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: { user: users, session: sessions, account: authAccounts, verification: verifications },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    // Login only: these providers never receive mailbox scopes (spec §5).
    socialProviders: google,
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, window: 60, max: 30 },
    advanced: { useSecureCookies: env.NODE_ENV === "production" },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

export async function getSession() {
  return getAuth().api.getSession({ headers: await headers() });
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}
```

`apps/web/src/lib/auth-client.ts`:
```ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
```

`apps/web/src/app/api/auth/[...all]/route.ts`:
```ts
import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export async function GET(request: Request) {
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(getAuth()).POST(request);
}
```

Run: `pnpm --filter @replywise/web test`
Expected: all tests PASS (8).

- [ ] **Step 4: Auth pages and forms**

`apps/web/src/app/(auth)/layout.tsx`:
```tsx
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2 text-sm font-semibold tracking-tight">
          <span aria-hidden className="grid size-7 place-items-center rounded-md bg-foreground text-xs font-bold text-background">
            R
          </span>
          Replywise
        </div>
        {children}
      </div>
    </div>
  );
}
```

`apps/web/src/components/auth/sign-in-form.tsx`:
```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (signInError) {
      setError(signInError.message ?? "Unable to sign in. Check your email and password.");
      return;
    }
    router.replace("/inbox");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your Replywise account.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-sm text-muted-foreground">
            New to Replywise?{" "}
            <Link href="/sign-up" className="font-medium text-foreground underline-offset-4 hover:underline">
              Create an account
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
```

`apps/web/src/components/auth/sign-up-form.tsx`:
```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export function SignUpForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: signUpError } = await authClient.signUp.email({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (signUpError) {
      setError(signUpError.message ?? "Unable to create your account.");
      return;
    }
    router.replace("/inbox");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Replywise drafts replies. It never sends email for you.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              aria-describedby="password-hint"
            />
            <p id="password-hint" className="text-xs text-muted-foreground">
              At least 12 characters.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Creating account…" : "Create account"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/sign-in" className="font-medium text-foreground underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
```

`apps/web/src/app/(auth)/sign-in/page.tsx`:
```tsx
import { SignInForm } from "@/components/auth/sign-in-form";
import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";

export const metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (await getSession()) redirect("/inbox");
  return <SignInForm />;
}
```

`apps/web/src/app/(auth)/sign-up/page.tsx`:
```tsx
import { SignUpForm } from "@/components/auth/sign-up-form";
import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";

export const metadata = { title: "Create account" };

export default async function SignUpPage() {
  if (await getSession()) redirect("/inbox");
  return <SignUpForm />;
}
```

`apps/web/src/components/app-shell/user-menu.tsx`:
```tsx
"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { initialsFor } from "@/lib/initials";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Account menu" className="w-full justify-start gap-2 px-1.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-medium">
            {initialsFor(name)}
          </span>
          <span className="truncate text-sm">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Replace `apps/web/src/app/(app)/layout.tsx`:
```tsx
import { AppShell } from "@/components/app-shell/app-shell";
import { UserMenu } from "@/components/app-shell/user-menu";
import { requireSession } from "@/lib/auth";
import type { ReactNode } from "react";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user } = await requireSession();
  return <AppShell accountSlot={<UserMenu name={user.name} email={user.email} />}>{children}</AppShell>;
}
```

- [ ] **Step 5: Write the e2e tests**

`apps/web/playwright.config.ts`:
```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /responsive\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    command: process.env.CI ? "pnpm start" : "pnpm dev",
    url: "http://localhost:3000/sign-in",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

`apps/web/e2e/auth.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const PASSWORD = "correct-horse-battery";

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
}

test("unauthenticated visitors are redirected to sign-in", async ({ page }) => {
  await page.goto("/inbox/urgent");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("a new user signs up, sees the app shell, signs out and signs back in", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, email);
  await expect(page.getByRole("link", { name: "Urgent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No mailboxes connected" })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("a wrong password shows an error and stays on sign-in", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, email);
  await page.context().clearCookies();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("definitely-not-it");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("responses carry security headers", async ({ request }) => {
  const response = await request.get("/sign-in");
  const headers = response.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-powered-by"]).toBeUndefined();
});
```

`apps/web/e2e/responsive.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

test("mobile users navigate through the sheet menu", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Mobile User");
  await page.getByLabel("Email").fill(`e2e-m-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Needs Reply" }).click();
  await expect(page).toHaveURL(/\/inbox\/needs-reply$/);
  await expect(page.getByRole("heading", { name: "Nothing in Needs Reply" })).toBeVisible();
});
```

- [ ] **Step 6: Run everything**

Run: `docker compose up -d --wait && pnpm db:migrate && pnpm --filter @replywise/web e2e`
Expected: 5 e2e tests PASS (4 desktop + 1 mobile).

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @replywise/web build`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): add email/password auth with Better Auth and protected app routes"
```

---

### Task 10: Container images and CI

**Files:**
- Create: `.dockerignore`, `apps/web/Dockerfile`, `apps/worker/Dockerfile`, `.github/workflows/ci.yml`
- Modify: `README.md` (deployment section)

**Interfaces:**
- Consumes: `pnpm build` outputs (`apps/web/.next/standalone`, `apps/worker/dist/{index,migrate}.js`), `packages/db/migrations`.
- Produces: images whose entrypoints are `node apps/web/server.js` (port 3000) and `node apps/worker/dist/index.js`; release command `node apps/worker/dist/migrate.js`.

- [ ] **Step 1: Docker files**

`.dockerignore`:
```
**/node_modules
**/.next
**/dist
**/.turbo
.git
.claude
.env
.env.*
coverage
playwright-report
test-results
```

`apps/web/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx --yes turbo@2 prune @replywise/web --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=@replywise/web

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/apps/web/.next/standalone ./
COPY --from=builder --chown=app:app /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=app:app /app/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

`apps/worker/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx --yes turbo@2 prune @replywise/worker --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@replywise/worker

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app ./
# dist/migrate.js resolves ../migrations relative to itself
COPY --from=builder --chown=app:app /app/packages/db/migrations ./apps/worker/migrations
USER app
CMD ["node", "apps/worker/dist/index.js"]
```

- [ ] **Step 2: Build images locally (if Docker is available)**

Run: `docker build -f apps/web/Dockerfile -t replywise-web . && docker build -f apps/worker/Dockerfile -t replywise-worker .`
Expected: both images build. Smoke test the worker against compose services:
```bash
docker run --rm --network host --env-file .env replywise-worker node apps/worker/dist/migrate.js
```
Expected: `migrations applied`. (On Docker Desktop for Windows/macOS replace `localhost` in the env file with `host.docker.internal` for this check.)

- [ ] **Step 3: CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  checks:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: replywise
          POSTGRES_PASSWORD: replywise
          POSTGRES_DB: replywise_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U replywise" --health-interval 2s --health-timeout 3s --health-retries 20
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping" --health-interval 2s --health-timeout 3s --health-retries 20
    env:
      CI: "true"
      APP_URL: http://localhost:3000
      DATABASE_URL: postgres://replywise:replywise@localhost:5432/replywise_test
      DATABASE_URL_TEST: postgres://replywise:replywise@localhost:5432/replywise_test
      REDIS_URL: redis://localhost:6379
      REDIS_URL_TEST: redis://localhost:6379
      # CI-only throwaway values. Never reuse outside CI.
      LOCAL_KEKS: v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
      BETTER_AUTH_SECRET: ci-only-secret-not-used-anywhere-else-000
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm db:migrate
      - run: pnpm test:int
      - run: pnpm build
      - run: pnpm --filter @replywise/web exec playwright install --with-deps chromium
      - run: pnpm --filter @replywise/web e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: apps/web/playwright-report
          retention-days: 7

  images:
    runs-on: ubuntu-latest
    needs: checks
    strategy:
      matrix:
        app: [web, worker]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/${{ matrix.app }}/Dockerfile
          push: false
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 4: README deployment section**

Append to `README.md`:
````markdown
## Deployment

Two images, one Postgres (≥16), one Redis:

| Image | Build | Run |
|---|---|---|
| web | `docker build -f apps/web/Dockerfile .` | `node apps/web/server.js` (port 3000) |
| worker | `docker build -f apps/worker/Dockerfile .` | `node apps/worker/dist/index.js` |

Release step before starting new versions: `node apps/worker/dist/migrate.js` (worker image).
Required env: see `.env.example`. In production `LOCAL_KEKS` is replaced by a KMS key provider (milestone M6).
````

- [ ] **Step 5: Full local verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int && pnpm build && pnpm --filter @replywise/web e2e`
Expected: every command exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "ci: add Dockerfiles for web and worker and GitHub Actions pipeline"
```

---

## Definition of done (M1)

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int && pnpm build && pnpm --filter @replywise/web e2e` all pass locally and in CI.
- A new user can sign up, see the responsive themed shell with the five category views, sign out and sign back in.
- The worker starts, registers the hourly body-purge scheduler, and shuts down cleanly on SIGTERM.
- Database schema for the full MVP exists as a committed migration; encrypted columns are `bytea` and every encryption helper requires an AAD.
