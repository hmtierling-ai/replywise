# Replywise — Product & Architecture Design

- **Date:** 2026-11-15
- **Status:** Draft, awaiting review
- **Scope:** Whole-product architecture + MVP. Implementation is split into milestone plans (see §10); the first is `docs/superpowers/plans/2026-11-15-m1-foundation.md`.

## 1. Product summary

Replywise connects to a user's Gmail and Outlook mailboxes, classifies incoming mail by urgency and importance with an explanation, summarizes threads, and generates reply suggestions that the user can edit, regenerate in another tone, and save **as drafts in the original provider**. Replywise **never sends email** — not automatically, not on user click. Sending happens only in the user's own mail client.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Audience | Individual users; one user owns many mailboxes. No teams, no billing in MVP. The schema keys everything on `user_id`, so a later `workspace` layer is additive. |
| Hosting | Containers: a Next.js web image + a Node worker image, Postgres, Redis. Platform-agnostic (Fly.io, Railway, Render, ECS…). |
| Email data retention | Persist metadata + AI results. Full message bodies cached **encrypted** with a TTL (default 14 days, user-configurable 1–30), then purged and refetched on demand. |
| AI trigger | Classification runs automatically on new mail. Summaries and replies are on demand. Optional per-mailbox "auto-draft for Needs Reply" toggle (default off). |
| Architecture | Approach A: one TypeScript monorepo, Next.js web + separate worker sharing domain packages; BullMQ on Redis behind a `JobQueue` interface. (Assumed — the recommended option; user moved on to planning without objecting.) |

## 2. Technology stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One type system across UI, API, worker. |
| Runtime | Node.js active LTS (≥ 22) | Native `crypto` AES-GCM, stable `fetch`. |
| Monorepo | pnpm workspaces + Turborepo | Fast installs, task caching, `turbo prune` for Docker. |
| Web | Next.js (App Router, React 19, Server Components, Server Actions) | Full-stack in one app; route handlers for OAuth callbacks and webhooks. |
| UI | Tailwind CSS v4 + shadcn/ui (Radix primitives), `lucide-react`, `next-themes`, `cmdk` (command palette), Geist/Inter type | The Linear/Superhuman look: dense, keyboard-first, accessible primitives we own. |
| App auth | Better Auth (Drizzle adapter, Postgres sessions) | Email+password and "Sign in with Google/Microsoft", passkeys later; sessions stored server-side, revocable. |
| Database | PostgreSQL ≥ 16 + Drizzle ORM + drizzle-kit migrations | Typed SQL, no runtime magic, SQL-first migrations. |
| Jobs | BullMQ 5 on Redis/Valkey | Retries with backoff, dedupe via `jobId`, schedulers, rate limiting, concurrency per queue. |
| Validation | Zod | Env, job payloads, API inputs, AI structured outputs. |
| AI | `@anthropic-ai/sdk` behind an `AiProvider` interface | BYOK; other providers plug in as adapters. |
| Mail APIs | Gmail REST API, Microsoft Graph — thin typed `fetch` clients | Few dependencies, full control of retries and quota handling. |
| Logging | pino with redaction | Secrets and email content never reach logs. |
| Testing | Vitest (unit + integration against real Postgres/Redis), Testing Library, Playwright (e2e) | Real infra in integration tests, no DB mocks. |
| Lint/format | Biome | One fast tool for lint + format. |
| CI | GitHub Actions with Postgres/Redis service containers | |

## 3. Application architecture

```
                ┌──────────────────────── apps/web (Next.js) ───────────────────────┐
 Browser ─────▶ │ UI (RSC + client islands) │ Server Actions │ Route handlers        │
                │  /inbox /thread /settings │ (mutations)    │  /api/auth/*          │
                │                           │                │  /api/oauth/{g,ms}/*  │
                │                           │                │  /api/webhooks/* (M6+)│
                └──────────────┬────────────┴───────┬────────┴──────────┬───────────┘
                               │ reads/writes       │ enqueue           │
                               ▼                    ▼                   │
                         ┌──────────┐        ┌────────────┐            │
                         │ Postgres │◀──────▶│   Redis    │            │
                         └──────────┘        │  (BullMQ)  │            │
                               ▲             └─────┬──────┘            │
                               │                   │ consume           │
                ┌──────────────┴───────────────────▼──────────────────┐│
                │ apps/worker (Node)                                   ││
                │  mailbox.sync · thread.classify · thread.summarize   ││
                │  draft.generate · draft.save · maintenance.*         ││
                └───────┬───────────────────────────────┬─────────────┘│
                        ▼                               ▼              │
              Gmail API / Microsoft Graph        Anthropic API (user's key)
```

### Packages (shared by web and worker)

| Package | Responsibility | Depends on |
|---|---|---|
| `@replywise/core` | Domain constants and types: categories, tones, provider ids, pure helpers. No I/O. | — |
| `@replywise/config` | Zod-validated environment parsing. | core |
| `@replywise/crypto` | Envelope encryption (AES-256-GCM), `KeyProvider` interface, local + KMS providers. | — |
| `@replywise/observability` | pino logger factory with mandatory redaction. | — |
| `@replywise/db` | Drizzle schema, client, migrations, query functions. | core, crypto |
| `@replywise/queue` | Job names + Zod payload schemas, `JobQueue` interface, BullMQ implementation, typed worker factory. | — |
| `@replywise/mail` (M2–M3) | `MailProvider` interface + `gmail` and `outlook` adapters (OAuth, read, draft create). **No send capability.** | core |
| `@replywise/ai` (M4) | `AiProvider` interface + `anthropic` adapter, prompts, output schemas. | core |

Rules: `apps/*` may import any package; packages never import from `apps/*`; `core` imports nothing. The web app never calls Gmail/Graph/Anthropic for bulk work — it enqueues jobs. Interactive single operations (generate a reply the user is waiting on) also run in the worker; the UI polls or subscribes to job status, so web requests stay short and keys stay in one process type.

### Key interfaces

```ts
// @replywise/mail — note the absence of any send method.
interface MailProvider {
  readonly id: "gmail" | "outlook";
  buildAuthorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;
  revoke(tokens: OAuthTokens): Promise<void>;
  getProfile(accessToken: string): Promise<{ email: string; displayName: string | null }>;
  listChanges(accessToken: string, cursor: SyncCursor | null): Promise<ChangeSet>;   // history.list / delta query
  getThread(accessToken: string, providerThreadId: string): Promise<ProviderThread>;
  createReplyDraft(accessToken: string, input: ReplyDraftInput): Promise<{ providerDraftId: string }>;
  updateReplyDraft(accessToken: string, providerDraftId: string, input: ReplyDraftInput): Promise<void>;
}

// @replywise/ai
interface AiProvider {
  readonly id: "anthropic";
  validateKey(apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  classify(ctx: AiContext, input: ClassifyInput): Promise<ClassifyResult>;      // structured output
  summarize(ctx: AiContext, input: SummarizeInput): Promise<SummaryResult>;
  draftReply(ctx: AiContext, input: DraftReplyInput): Promise<DraftReplyResult>;
}
// AiContext = { apiKey, model, effort, onUsage(usage) } — keys passed per call, never stored on the instance.
```

## 4. Database schema

All ids are UUIDs except Better Auth tables (text ids it generates). Timestamps are `timestamptz`. `bytea` columns hold envelope-encrypted blobs (§6). Deleting a user cascades everything except audit rows (`user_id` set null).

**Auth (Better Auth-owned):** `users`, `sessions`, `auth_accounts` (login identities — distinct from mailboxes), `verifications`.

**`mail_accounts`** — a connected mailbox.
`id`, `user_id → users`, `provider` (`gmail|outlook`), `email_address`, `display_name`, `status` (`active|needs_reauth|error`), `granted_scopes text[]`, `tokens_ciphertext bytea` (JSON `{accessToken, refreshToken, expiresAt}`), `sync_cursor text` (Gmail `historyId` / Graph `deltaLink`), `last_synced_at`, `last_error`, `auto_draft_needs_reply bool default false`, `created_at`, `updated_at`. Unique `(user_id, provider, email_address)`.

**`mail_oauth_states`** — in-flight connect attempts (10-minute TTL).
`state_hash text pk` (SHA-256 of the random state), `user_id`, `provider`, `code_verifier_ciphertext bytea`, `return_to text`, `expires_at`.

**`threads`** — `id`, `mail_account_id → mail_accounts`, `provider_thread_id`, `subject`, `snippet`, `participants jsonb`, `last_message_at`, `message_count`, `is_unread`, `provider_labels text[]`, `created_at`, `updated_at`. Unique `(mail_account_id, provider_thread_id)`. Index `(mail_account_id, last_message_at desc)`.

**`messages`** — `id`, `thread_id → threads`, `mail_account_id`, `provider_message_id`, `internet_message_id`, `from_address jsonb`, `to_addresses jsonb`, `cc_addresses jsonb`, `subject`, `snippet`, `sent_at`, `is_from_user`, `has_attachments`, `body_ciphertext bytea null`, `body_expires_at timestamptz null`, `created_at`. Unique `(mail_account_id, provider_message_id)`. Partial index on `body_expires_at` where not null.

**`thread_insights`** — latest AI classification/summary per thread (one row per thread).
`thread_id pk → threads`, `category` (`urgent|important|needs_reply|informational|low_priority`), `urgency smallint 1–5`, `importance smallint 1–5`, `needs_reply bool`, `reasons jsonb` (string array, shown to the user verbatim as plain text), `summary text null`, `summary_through_message_id uuid null`, `classified_through_message_id uuid`, `ai_provider`, `model`, `prompt_version`, `created_at`, `updated_at`. Index `(category)` joined via threads.

Category is a single primary bucket by precedence **Urgent > Important > Needs Reply > Informational > Low Priority**; urgency/importance/needs_reply are kept separately so filters can combine them.

**`reply_drafts`** — `id`, `thread_id → threads`, `user_id`, `tone` (`professional|friendly|concise|formal|casual`), `instructions text null`, `body_ciphertext bytea` (the reply text, encrypted — it is user email content), `status` (`generated|edited|saved|discarded`), `provider_draft_id null`, `saved_at null`, `ai_provider`, `model`, `created_at`, `updated_at`. Deleted together with the thread.

**`ai_credentials`** — `id`, `user_id`, `provider` (`anthropic`), `key_ciphertext bytea`, `key_hint text` (last 4 chars), `status` (`unverified|valid|invalid`), `last_validated_at`, `created_at`, `updated_at`. Unique `(user_id, provider)`.

**`user_preferences`** — `user_id pk`, `default_tone`, `signature text`, `writing_style_notes text`, `reply_language text null` (null = match the email), `classification_model`, `generation_model`, `body_cache_days smallint default 14`, `updated_at`.

**`ai_usage_events`** — `id`, `user_id`, `mail_account_id null`, `task` (`classify|summarize|draft`), `ai_provider`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `created_at`. Lets users see what their key is spending.

**`audit_logs`** — `id`, `user_id null`, `action` (e.g. `mailbox.connected`, `mailbox.disconnected`, `ai_key.updated`, `draft.saved`), `target_type`, `target_id`, `ip`, `user_agent`, `metadata jsonb`, `created_at`. Never contains email content or secrets.

## 5. Authentication and OAuth flows

There are **two independent OAuth relationships**, deliberately separated:

1. **App login** (Better Auth): email+password (min 12 chars, rate-limited) and optional "Sign in with Google/Microsoft" requesting only `openid email profile`. Sessions are server-side rows; cookie is `HttpOnly; Secure; SameSite=Lax`. Signing in with Google does **not** grant mailbox access.
2. **Mailbox connection** (our own flow in `@replywise/mail`), one per mailbox, Authorization Code + PKCE (S256), confidential client:
   1. Signed-in user clicks *Connect Gmail/Outlook*. Server generates `state` (32 random bytes) and `code_verifier`, stores `sha256(state)` + encrypted verifier in `mail_oauth_states`, redirects to the provider with `prompt=consent`, `access_type=offline` (Google) / `offline_access` scope (Microsoft).
   2. Callback `/api/oauth/{gmail|outlook}/callback` verifies the session user equals the state row's user, state not expired, single-use (row deleted in the same transaction).
   3. Exchanges code → tokens; verifies **all required scopes were granted** (Google lets users untick scopes); fetches the profile email.
   4. Upserts `mail_accounts` with encrypted tokens, writes `audit_logs`, enqueues `mailbox.sync` (initial backfill).
   - **Scopes — Gmail:** `gmail.readonly`, `gmail.compose` (required for `drafts.create`; Google has no draft-only scope, so the "never send" guarantee is enforced in code, §8). **Microsoft Graph:** `offline_access`, `User.Read`, `Mail.ReadWrite` (drafts). **`Mail.Send` is never requested.**
   - **Refresh:** the worker refreshes when `expiresAt − 5 min` has passed, under a per-mailbox Redis lock so concurrent jobs don't race and invalidate rotating refresh tokens (Microsoft rotates). `invalid_grant` → status `needs_reauth`, sync paused, UI banner to reconnect.
   - **Disconnect:** revoke at provider (Google `oauth2/revoke`; Microsoft has no per-app revoke API — we delete tokens and link the user to their account's app-permissions page), delete the `mail_accounts` row (cascades threads, messages, insights, drafts), remove scheduled jobs, audit log.
   - **Launch requirements (not code, but blocking):** Gmail restricted scopes require Google OAuth app verification + annual CASA assessment before public launch (≤100 test users until then). Microsoft requires publisher verification for multi-tenant apps to avoid "unverified" consent warnings.

## 6. Secrets: AI keys and OAuth tokens

**Envelope encryption** in `@replywise/crypto`:
- Each encrypt call generates a fresh 256-bit data key (DEK), encrypts the plaintext with AES-256-GCM (random 96-bit IV), and wraps the DEK with a key-encryption key (KEK) held by a `KeyProvider`.
- Blob format: `version(1) | keyIdLen(1) | keyId | wrappedDekLen(2) | wrappedDek | iv(12) | tag(16) | ciphertext`. Self-describing, so KEK rotation is lazy: new writes use the current KEK, old blobs still decrypt by `keyId`, a maintenance job re-wraps.
- **Associated data (AAD)** binds each blob to its owner and purpose, e.g. `ai_credential:{userId}:anthropic`, `mail_tokens:{mailAccountId}`, `message_body:{messageId}`. A blob copied to another row fails to decrypt.
- **KeyProviders:** `LocalKeyProvider` (KEKs from env `LOCAL_KEKS="v1:<base64-32-bytes>,…"`, dev/test and small self-hosted) and `AwsKmsKeyProvider` / `GcpKmsKeyProvider` (M6, production — KEK never leaves KMS).

**AI API key handling:**
- Entered once in Settings over HTTPS → Server Action validates format (`sk-ant-…`) and liveness (`validateKey`, a cheap Models API call) → encrypted → stored. The browser only ever sees `key_hint` (`••••abcd`) and status.
- Decrypted only inside the worker, just-in-time per job, passed to the SDK client constructed for that job, then dropped. Never cached in Redis, never in job payloads (payloads carry ids only), never logged (pino redaction + no request/response body logging for AI calls).
- Replace/delete is immediate; `invalid` (401 from provider) pauses auto-classification and surfaces a banner.

**AI model configuration:** per-task model stored in `user_preferences`. Default for every task is `claude-opus-5-5`; classification runs with `effort: "low"` and structured output, generation with `effort: "medium"`. Users may choose `claude-haiku-5-5` for classification to cut cost substantially — offered in Settings, not chosen for them.

## 7. Email synchronization and background processing

**Queues (BullMQ, one Redis):** `sync`, `ai`, `maintenance`, each with its own worker concurrency. Job payloads contain only ids. Job ids give dedupe: `sync:{mailAccountId}` ensures at most one pending sync per mailbox.

**Sync (M3, polling first):**
- *Initial backfill* on connect: last 30 days of inbox threads (Gmail `threads.list q=newer_than:30d in:inbox`; Graph `/me/mailFolders/inbox/messages/delta` with a date filter), paged, with body fetch for the newest message per thread.
- *Incremental:* a scheduler enqueues `mailbox.sync` every 2 minutes per active mailbox. Gmail: `history.list(startHistoryId)`; on 404 (history expired) → bounded re-backfill. Graph: follow `deltaLink`; on `syncStateNotFound` → re-backfill.
- Upserts threads/messages idempotently on `(mail_account_id, provider_*_id)`; stores the new cursor **in the same transaction** as the upserts.
- For each thread whose newest message is new and not from the user → enqueue `thread.classify` (if the user has a valid AI key).
- *Push (post-MVP):* Gmail `users.watch` → Pub/Sub → webhook; Graph change-notification subscriptions → webhook. Webhooks only enqueue the same `mailbox.sync` job, so the engine does not change.

**Quota and resilience:** per-provider rate limiter in the worker (Gmail per-user quota units, Graph throttling with `Retry-After`); exponential backoff with jitter; 5 attempts then dead-letter with `mail_accounts.last_error`. Token refresh under a per-mailbox lock (§5).

**AI jobs:** `thread.classify` (auto), `thread.summarize`, `draft.generate` (on demand; UI shows progress via polling `/api/jobs/{id}` in MVP), `draft.save` (writes to provider drafts; updates existing provider draft if one exists for this reply). Inputs are trimmed deterministically (newest messages first, quoted history stripped, attachments listed by name only) to a token budget; prompts are cached where the prefix is stable.

**Maintenance:** `maintenance.purgeBodies` hourly (null out expired `body_ciphertext`), `maintenance.purgeOAuthStates` hourly, `maintenance.rewrapKeys` (manual, on KEK rotation).

## 8. Security risks and mitigations

| Risk | Mitigation |
|---|---|
| Replywise sends an email | `MailProvider` has no send method; Graph `Mail.Send` never requested; CI test fails on any reference to Gmail `messages/send`, `drafts/send`, or Graph `/sendMail`, `/send`; drafts are created only in `draft.save`. |
| Token / AI-key theft from DB | Envelope encryption with AAD (§6); KEK in KMS in production; DB credentials scoped per app; backups encrypted. |
| Secrets in logs, errors, analytics | pino redaction paths; never log request/response bodies of mail/AI calls; env parsing errors list key names only; Sentry-style tools configured with scrubbing (M6). |
| Prompt injection inside emails | Email content is placed in clearly delimited untrusted blocks; the model has **no tools**; outputs are schema-validated (Zod) and rendered as plain text; worst case is a bad suggestion the user must review — it can never send or exfiltrate via actions. Reply drafts are never auto-saved unless the user enabled auto-draft, and even then are only drafts. |
| OAuth CSRF / code injection | `state` single-use, bound to the session user, 10-min TTL; PKCE S256; exact redirect URIs registered. |
| Over-broad scopes | Minimal scopes (§5); verify granted scopes at callback; no send scopes. |
| Refresh-token races (rotation) | Per-mailbox Redis lock around refresh. |
| XSS via email HTML | MVP renders bodies as sanitized HTML (DOMPurify server-side, no scripts/forms/remote images by default) inside a sandboxed iframe with `sandbox` and restrictive CSP; AI output is text only. |
| Session theft / CSRF | Server-side sessions, `HttpOnly Secure SameSite=Lax` cookies; Server Actions' built-in origin checks; security headers (CSP, `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy`). |
| Cross-tenant data access | Every query function takes `userId` and joins through `mail_accounts.user_id`; integration tests assert user A cannot read user B's threads/drafts. |
| Abuse / brute force | Better Auth rate limiting on auth routes; per-user rate limits on AI job enqueue. |
| Data retention / privacy | Body TTL purge; mailbox disconnect hard-deletes data; account deletion cascades; privacy policy satisfying Google's Limited Use requirements (no human reading, no ads, no model training on user data). |
| Dependency / supply chain | Lockfile, Renovate, `pnpm audit` in CI, minimal deps for mail clients. |

## 9. MVP scope

**In:**
- Sign up / sign in (email+password; Google sign-in optional), sign out, delete account.
- Connect multiple Gmail and Outlook mailboxes; reconnect when `needs_reauth`; disconnect with data purge.
- Sync: 30-day backfill + 2-minute incremental polling; encrypted body cache with TTL.
- Settings: Anthropic API key (validate, replace, delete), default tone, signature, writing-style notes, models per task, body cache days, auto-draft toggle per mailbox, AI usage summary.
- Intelligent inbox: unified + per-mailbox views; tabs for Urgent / Important / Needs Reply / Informational / Low Priority; each thread shows category, urgency/importance, and "why" reasons.
- Thread view: messages, on-demand summary, reply composer: generate, edit, regenerate with tone/instructions, **Save to drafts** (creates/updates provider draft) with a link to open it in Gmail/Outlook.
- Premium UI: light/dark/system theme, responsive (mobile read + draft), keyboard navigation (`j/k`, `e`… and `⌘K` palette).

**Out (post-MVP):** billing, teams/workspaces, push notifications, additional AI providers (interface exists), attachment content analysis, full-text search, snooze/labels management, mobile apps, any send capability (permanently out).

## 10. Roadmap

Each milestone gets its own implementation plan and ends in working, tested software.

| Milestone | Deliverable |
|---|---|
| **M1 Foundation** | Monorepo + tooling, Docker Compose (Postgres, Redis), `core`, `config`, `crypto`, `observability`, `db` (full schema + migrations), `queue`, worker skeleton with real body-purge job, web app shell (theme, layout, category nav), app auth (sign up/in/out, protected routes), security headers, Dockerfiles, CI. |
| **M2 Mailbox connection** | `@replywise/mail` OAuth for Gmail + Outlook, token encryption/refresh with lock, connect/reconnect/disconnect UI, audit log. |
| **M3 Sync engine** | Backfill + incremental sync for both providers, body cache + purge, thread list UI (unclassified), thread view with sanitized HTML. |
| **M4 AI classification** | AI key settings, `@replywise/ai` + Anthropic adapter, `thread.classify`, intelligent inbox tabs with reasons, usage tracking. |
| **M5 Summaries & drafts** | Summary, reply generation with tones, editor, regenerate, save/update provider drafts, auto-draft toggle, send-guard CI test. |
| **M6 Hardening & launch** | KMS key provider, nonce-based CSP, per-user rate limits, error tracking with scrubbing, e2e suite across flows, Google verification/CASA + Microsoft publisher verification prep, privacy policy. |
| Post-MVP | Push sync, billing (Stripe), more AI providers, teams. |

## 11. Folder structure

```
replywise/
├─ apps/
│  ├─ web/                    Next.js app
│  │  ├─ src/app/
│  │  │  ├─ (auth)/sign-in, sign-up
│  │  │  ├─ (app)/inbox/[category], thread/[id], settings/*
│  │  │  └─ api/auth/[...all], api/oauth/{gmail,outlook}/{start,callback}, api/jobs/[id]
│  │  ├─ src/components/{ui,app-shell,inbox,thread,settings}
│  │  ├─ src/lib/{auth.ts, auth-client.ts, db.ts, env.ts}
│  │  └─ e2e/                 Playwright
│  └─ worker/
│     └─ src/{index.ts, jobs/*.ts, env.ts}
├─ packages/
│  ├─ core/ config/ crypto/ observability/ db/ queue/   (M1)
│  ├─ mail/                                              (M2)
│  └─ ai/                                                (M4)
├─ docker/postgres/init.sql
├─ docker-compose.yml
├─ docs/superpowers/{specs,plans}/
├─ .github/workflows/ci.yml
├─ biome.json  turbo.json  pnpm-workspace.yaml  tsconfig.base.json  package.json
```

## 12. Testing strategy

- **Unit (Vitest):** pure logic — crypto, env parsing, category precedence, prompt input trimming, provider response mapping (fixtures recorded from real API shapes).
- **Integration (Vitest, real Postgres + Redis via Docker Compose / CI services):** migrations, constraints, cascade deletes, cross-tenant isolation, queue round-trips, sync idempotency.
- **E2E (Playwright):** auth flows, settings, inbox rendering against seeded data; provider and AI calls stubbed at the HTTP boundary in e2e only.
- **Guards:** CI "no-send" scan (M5), secret-redaction tests, header assertions.
