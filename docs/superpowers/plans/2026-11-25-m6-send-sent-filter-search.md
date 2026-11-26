# M6 Confirmed Sending, Sent Sync, Gmail Tab Filter and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can send a reply from Replywise after an explicit click, a confirmation dialog and a 10-second undo window. Synced mail now includes Sent, Gmail's Promotions/Social/Updates threads move to an "Other" view, and the user can search local threads or all of Gmail and import Gmail results.

**Architecture:**
- Sending is a DB state machine on `reply_drafts`: `generated|edited|saved → scheduled → sending → sent | send_failed`. Every transition is a conditional `UPDATE … WHERE status = <expected>`. The web confirm action writes `scheduled` and enqueues a delayed `draft.send` job on a new `send` queue. The worker claims the row, writes the Gmail draft with the M5 code, then calls Gmail's send-draft endpoint once. Only a rate limit is ever retried.
- The only code that can deliver mail is `packages/mail/src/gmail-send.ts` (subpath export `@replywise/mail/gmail-send`), imported only by `apps/worker/src/jobs/send-draft.ts`. The no-send guard enforces both rules.
- "Other" is one SQL helper (`otherThreadSql`) used by the inbox, category, count, Other and classification-scan queries. Sent and Other are new list views over the same thread list component.
- Local search is `ILIKE` over `subject`, `snippet` and a generated `participants_text` column, backed by `pg_trgm` GIN indexes. "Search all of Gmail" runs in a Server Action through `@replywise/sync` (`searchGmailThreads`, `importThread`), limited per user in Redis.

**Tech Stack:** As M5: pnpm 11 + Turborepo, TypeScript strict, Next.js 16.4 (cacheComponents), Drizzle 0.45 / postgres.js / Postgres 17 (+ `pg_trgm`), BullMQ 6 / ioredis, Zod 4, Vitest, Playwright, Biome. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-m6-send-sent-filter-search-design.md` (binding). It amends §1, §8, §9 and §10 of `docs/superpowers/specs/2026-11-15-replywise-design.md`.

## Global Constraints

### Sending (spec §1, §2)
- Replywise sends **replies only**, and only after an explicit user click plus a confirmation dialog. AI jobs and auto-draft never send. Only the confirmed Server Action creates a `scheduled` row.
- Confirmed sends wait **10 seconds** (`SEND_DELAY_MS = 10_000`) with an "Undo" button before anything reaches Gmail.
- Send mechanism: save/update the provider draft (M5 code), then Gmail `POST drafts/send`. Never `messages.send`.
- A send is never retried after the request may have reached Gmail. Only a rate limit (before the call, or a rate-limit answer from the call) is retried.
- At most **20 sends per user per rolling hour**, counted from `reply_drafts.sent_at` plus rows in `scheduled|sending` → `send_rate_limited`.
- Send is Gmail-only. Outlook drafts keep their current behaviour.
- No new OAuth scope (`gmail.compose` already permits `drafts/send`).

### No-send guard (spec §2.3)
- The pattern `drafts/send` is allowed only in `packages/mail/src/gmail-send.ts`. `createGmailSendApi` may be imported only by `apps/worker/src/jobs/send-draft.ts`. `messages/send`, `messages.send`, Graph `sendMail`/`/send`, `/reply`, `/forward` stay forbidden everywhere. The guard test enforces the allowlist and the single importer.
- Never write the strings `drafts.send`, `messages.send`, `mail.send` (for example `gmail.sendDraft(...)`) or a slash directly followed by `send` (other than the allowlisted URL) in any scanned file, comments included. Name the send client variable `sender`.

### Data and security
- Every web query is scoped by the signed-in `userId`. Worker queries take ids from trusted payloads.
- DB state transitions are conditional `UPDATE … WHERE status = <expected>` and, for web calls, `AND user_id = <userId>`.
- Postgres 55P04: new enum values are not used (defaults, data, partial-index predicates) in migration `0003` that adds them.
- Fixed error codes only. Never log or store bodies, recipients, tokens or search query text. Draft bodies stay encrypted with `aad.replyDraft(id)`.
- Audit actions `draft.send_scheduled`, `draft.send_undone`, `draft.sent`, `draft.send_failed`; metadata is `{ draftId, threadId, mailAccountId }` plus `error` for failures. Never body or recipients.
- Gmail search: query ≤ 200 characters; one in-flight search per user and ≤ 30 per minute (Redis); errors map to `needs_reauth`, `rate_limited`, `gmail_error` (plus `invalid_query` for rejected input).

### Next.js 16 rules
- Session, DB, `params` and `searchParams` reads go inside `<Suspense>`. `await connection()` before `new Date()` in render. `PageProps` from `next typegen`. No `force-dynamic`.

### Infrastructure
- Postgres and Redis run from the main checkout's compose project (`D:\replywise`). Never run `docker compose up` from a worktree. Docker CLI: `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`.
- The machine has ~8 GB RAM: no step starts a dev server. e2e runs through the existing Playwright config with `--workers=1`; keep :3000 and :4010 free.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on: use conditional spreads and handle `undefined` from indexing.
- Never add dependencies that need pnpm `minimumReleaseAgeExclude`. This plan adds none.

### Commits
- Commit after every task. Conventional messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map (M6)

```
packages/db/migrations/0003_send_search.sql (+ meta snapshot/journal via drizzle-kit generate --name)
packages/db/src/schema/{enums,ai,mail}.ts           draft_status values, send columns, participants_text, indexes
packages/db/src/queries/send.ts NEW (+ .int.test)   send state machine, stuck scans, rate-limit count
packages/db/src/queries/threads.ts                  otherThreadSql, inbox/sent/other lists, countThreadViews
packages/db/src/queries/search.ts NEW (+ .test, .int.test)   escapeLikePattern, searchThreads
packages/db/src/queries/{generation,ai,audit,sync}.ts   discard guard, hasActiveSend, scan skip, audit actions, findLocalThreadIds
packages/core/src/mail.ts                           pickReplyTarget, replySubject
packages/mail/src/gmail-send.ts NEW (+ test)        the only delivery code (drafts/send)
packages/mail/src/gmail-api.ts                      getThreadMetadata, baseUrl option
packages/mail/src/no-send.test.ts                   allowlist + single importer
packages/sync/src/{sync-mailbox,gmail-search,testing}.ts   backfill query, importThread, searchGmailThreads
packages/queue/src/{jobs,bullmq}.ts                 "send" queue, draft.send, maintenance.recoverSends, removeJob, sendJobId
apps/worker/src/jobs/{send-draft,recover-sends,gmail-draft-write}.ts NEW; save-draft.ts, generation-errors.ts, main.ts
apps/worker/src/send.int.test.ts NEW
apps/web/src/app/(app)/thread/[id]/send-actions.ts NEW (+ test); actions.ts; page.tsx
apps/web/src/components/thread/{send-controls,send-countdown}.tsx NEW; reply-composer.tsx; thread-view.tsx
apps/web/src/app/(app)/{sent,other,search}/page.tsx NEW; search/actions.ts NEW (+ test)
apps/web/src/components/inbox/{thread-list,other-tabs,search-box}.tsx; components/search/gmail-search.tsx NEW
apps/web/src/components/app-shell/{nav-items,nav-links,sidebar-content,mobile-nav,app-shell}.tsx; (app)/layout.tsx
apps/web/src/lib/{nav-counts,search-limit,redis-limiter,search-messages,draft-messages,sync}.ts
packages/config/src/env.ts                          E2E_FAKE_GMAIL_URL (loopback only)
apps/web/e2e/{seed,fake-gmail}.ts; send.spec.ts, views.spec.ts, gmail-search.spec.ts NEW; playwright.config.ts
README.md, docs/superpowers/notes/2026-11-16-m2-followups.md
```

---

### Task 1: Migration 0003 and the send state machine queries

**Files:**
- Modify: `packages/db/src/schema/enums.ts`, `packages/db/src/schema/ai.ts`, `packages/db/src/schema/mail.ts`
- Create: `packages/db/migrations/0003_send_search.sql` (+ `meta/0003_snapshot.json`, `meta/_journal.json` entry, generated)
- Create: `packages/db/src/queries/send.ts`, `packages/db/src/queries/send.int.test.ts`
- Modify: `packages/db/src/queries/generation.ts` (`discardDraft` guard), `packages/db/src/queries/audit.ts`, `packages/db/src/index.ts`

**Interfaces:**
- Produces, exported from `@replywise/db`:
  - `draftStatusEnum` gains `scheduled`, `sending`, `sent`, `send_failed`; `replyDrafts` gains `sendAt: Date | null`, `sentAt: Date | null`, `providerMessageId: string | null`; `threads` gains generated `participantsText: string`.
  - Constants: `SEND_DELAY_MS = 10_000`, `SEND_RATE_LIMIT = 20`, `SEND_RATE_WINDOW_MS = 3_600_000`, `SEND_OVERDUE_MS = 60_000`, `SEND_STUCK_MS = 600_000`, `SEND_ATTEMPTED = "send_attempted"`, `RESENDABLE_FAILURES: readonly ["send_rejected", "gmail_reauth", "gmail_unavailable", "no_recipient", "internal"]`.
  - `scheduleSend(db, userId, draftId, sendAt: Date, now: Date): Promise<boolean>`
  - `undoSend(db, userId, draftId, now: Date): Promise<{ sendAt: Date | null } | null>`
  - `claimSend(db, draftId, now: Date): Promise<boolean>`
  - `markSendAttempted(db, draftId): Promise<boolean>` / `clearSendAttempted(db, draftId): Promise<void>`
  - `recordSendDraftId(db, draftId, providerDraftId): Promise<void>`
  - `markSent(db, draftId, providerMessageId, sentAt: Date): Promise<boolean>`
  - `failSend(db, draftId, error: string): Promise<boolean>`
  - `reopenFailedSend(db, userId, draftId, now: Date): Promise<boolean>`
  - `countRecentSends(db, userId, now: Date): Promise<number>`
  - `hasActiveSend(db, userId, threadId): Promise<boolean>`
  - `getDraftMailbox(db, userId, draftId): Promise<DraftMailbox | null>` with `DraftMailbox = { threadId: string; mailAccountId: string; provider: MailProviderId }`
  - `listOverdueScheduledSends(db, now: Date, limit?: number): Promise<Array<{ draftId: string; sendAt: Date }>>`
  - `expireScheduledSends(db, now: Date): Promise<FailedSendRow[]>`, `failStuckSends(db, now: Date): Promise<FailedSendRow[]>` with `FailedSendRow = { draftId; userId; threadId; mailAccountId; error }`
  - `AuditAction` gains `"draft.send_scheduled" | "draft.send_undone" | "draft.sent" | "draft.send_failed"`.
- `discardDraft` refuses `scheduled`, `sending` and `sent` drafts.

- [ ] **Step 1: Schema**

`packages/db/src/schema/enums.ts`: append the four values at the end (order matters for `ADD VALUE`):
```ts
export const draftStatusEnum = pgEnum("draft_status", [
  "pending",
  "generated",
  "edited",
  "saved",
  "discarded",
  "failed",
  "scheduled",
  "sending",
  "sent",
  "send_failed",
]);
```

`packages/db/src/schema/ai.ts`, in `replyDrafts`, after `savedAt`:
```ts
    /** When a confirmed send leaves its undo window (status scheduled). */
    sendAt: timestamp("send_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Gmail message id returned by the send call. */
    providerMessageId: text("provider_message_id"),
```
and replace the table's index list with:
```ts
  (t) => [
    index("reply_drafts_thread_created_idx").on(t.threadId, t.createdAt),
    index("reply_drafts_status_send_at_idx").on(t.status, t.sendAt),
  ],
```

`packages/db/src/schema/mail.ts`, in `threads`, after `providerLabels`:
```ts
    /** Lower-cased participants JSON, for trigram search (spec M6 §5.1). jsonb→text is immutable. */
    participantsText: text("participants_text").generatedAlwaysAs(sql`lower(participants::text)`),
```
and replace the threads index list with:
```ts
  (t) => [
    uniqueIndex("threads_account_provider_thread_uq").on(t.mailAccountId, t.providerThreadId),
    index("threads_account_last_message_idx").on(t.mailAccountId, t.lastMessageAt.desc()),
    index("threads_provider_labels_gin_idx").using("gin", t.providerLabels),
    index("threads_subject_trgm_idx").using("gin", t.subject.op("gin_trgm_ops")),
    index("threads_snippet_trgm_idx").using("gin", t.snippet.op("gin_trgm_ops")),
    index("threads_participants_trgm_idx").using("gin", t.participantsText.op("gin_trgm_ops")),
  ],
```

- [ ] **Step 2: Generate and hand-check the migration**

Run: `pnpm --filter @replywise/db generate --name send_search`
Expected: `migrations/0003_send_search.sql`, `meta/0003_snapshot.json` and a new `_journal.json` entry with tag `0003_send_search`. Do not rename anything by hand.

Edit the SQL file:
1. Insert as the **first** line: `CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint` (drizzle-kit does not emit extensions; the trigram indexes need it).
2. Confirm it contains, in this order of meaning (formatting may differ):
```sql
ALTER TYPE "public"."draft_status" ADD VALUE 'scheduled';
ALTER TYPE "public"."draft_status" ADD VALUE 'sending';
ALTER TYPE "public"."draft_status" ADD VALUE 'sent';
ALTER TYPE "public"."draft_status" ADD VALUE 'send_failed';
ALTER TABLE "reply_drafts" ADD COLUMN "send_at" timestamp with time zone;
ALTER TABLE "reply_drafts" ADD COLUMN "sent_at" timestamp with time zone;
ALTER TABLE "reply_drafts" ADD COLUMN "provider_message_id" text;
ALTER TABLE "threads" ADD COLUMN "participants_text" text GENERATED ALWAYS AS (lower(participants::text)) STORED;
CREATE INDEX "reply_drafts_status_send_at_idx" ON "reply_drafts" USING btree ("status","send_at");
CREATE INDEX "threads_provider_labels_gin_idx" ON "threads" USING gin ("provider_labels");
CREATE INDEX "threads_subject_trgm_idx" ON "threads" USING gin ("subject" gin_trgm_ops);
CREATE INDEX "threads_snippet_trgm_idx" ON "threads" USING gin ("snippet" gin_trgm_ops);
CREATE INDEX "threads_participants_trgm_idx" ON "threads" USING gin ("participants_text" gin_trgm_ops);
```
3. If drizzle-kit re-creates the enum type instead of `ADD VALUE`, replace that with the four `ALTER TYPE … ADD VALUE IF NOT EXISTS …` lines above. Nothing in this migration may use a new value (55P04): no default change, no data update, no partial index on them.

Run: `pnpm db:migrate`
Expected: applies cleanly to the dev DB (the integration tests migrate the test DB themselves).

- [ ] **Step 3: Write the failing integration tests**

Create `packages/db/src/queries/send.int.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { replyDrafts } from "../schema/ai";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import { discardDraft, getDraftForUser } from "./generation";
import {
  claimSend,
  clearSendAttempted,
  countRecentSends,
  expireScheduledSends,
  failSend,
  failStuckSends,
  getDraftMailbox,
  hasActiveSend,
  listOverdueScheduledSends,
  markSendAttempted,
  markSent,
  recordSendDraftId,
  reopenFailedSend,
  SEND_ATTEMPTED,
  SEND_DELAY_MS,
  scheduleSend,
  undoSend,
} from "./send";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

const NOW = new Date("2026-11-25T12:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

async function seed(provider: "gmail" | "outlook" = "gmail") {
  const alice = await insertUser(db);
  const bob = await insertUser(db);
  const box = await insertMailAccount(db, alice.id, { provider });
  const thread = await insertThread(db, box.id, { providerLabels: ["INBOX"] });
  await insertMessage(db, thread.id, box.id);
  return { alice, bob, box, thread };
}

async function draft(
  userId: string,
  threadId: string,
  overrides: Partial<typeof replyDrafts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(replyDrafts)
    .values({
      threadId,
      userId,
      tone: "professional",
      bodyCiphertext: Buffer.from("b"),
      status: "generated",
      aiProvider: "anthropic",
      model: "claude-opus-5-5",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("draft insert failed");
  return row.id;
}

describe("scheduleSend and undoSend", () => {
  it("schedules an owned draft, undoes it back to edited, and is scoped to the owner", async () => {
    const { alice, bob, thread } = await seed();
    const id = await draft(alice.id, thread.id);
    const sendAt = at(SEND_DELAY_MS);
    expect(await scheduleSend(db, bob.id, id, sendAt, NOW)).toBe(false);
    expect(await scheduleSend(db, alice.id, id, sendAt, NOW)).toBe(true);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({ status: "scheduled", sendAt });
    expect(await scheduleSend(db, alice.id, id, sendAt, NOW)).toBe(false); // already scheduled
    expect(await hasActiveSend(db, alice.id, thread.id)).toBe(true);
    expect(await hasActiveSend(db, bob.id, thread.id)).toBe(false);
    expect(await discardDraft(db, alice.id, id, NOW)).toBe(false);

    expect(await undoSend(db, bob.id, id, NOW)).toBeNull();
    expect(await undoSend(db, alice.id, id, NOW)).toEqual({ sendAt });
    expect((await getDraftForUser(db, alice.id, id))?.status).toBe("edited");
    expect(await undoSend(db, alice.id, id, NOW)).toBeNull(); // only from scheduled
  });

  it("refuses drafts that are not sendable", async () => {
    const { alice, thread } = await seed();
    for (const status of ["pending", "failed", "discarded", "sent", "sending"] as const) {
      const id = await draft(alice.id, thread.id, { status });
      expect(await scheduleSend(db, alice.id, id, at(SEND_DELAY_MS), NOW), status).toBe(false);
    }
    const saving = await draft(alice.id, thread.id, { saveRequestedAt: at(-MIN) });
    expect(await scheduleSend(db, alice.id, saving, at(SEND_DELAY_MS), NOW)).toBe(false);
    const staleSave = await draft(alice.id, thread.id, { saveRequestedAt: at(-11 * MIN) });
    expect(await scheduleSend(db, alice.id, staleSave, at(SEND_DELAY_MS), NOW)).toBe(true);
  });

  it("allows a new send after a failure that proves nothing was sent, never after send_unconfirmed", async () => {
    const { alice, thread } = await seed();
    const rejected = await draft(alice.id, thread.id, {
      status: "send_failed",
      error: "send_rejected",
    });
    const saveError = await draft(alice.id, thread.id, {
      status: "send_failed",
      error: "gmail_unavailable",
    });
    const unconfirmed = await draft(alice.id, thread.id, {
      status: "send_failed",
      error: "send_unconfirmed",
    });
    expect(await scheduleSend(db, alice.id, rejected, at(SEND_DELAY_MS), NOW)).toBe(true);
    expect(await scheduleSend(db, alice.id, saveError, at(SEND_DELAY_MS), NOW)).toBe(true);
    expect(await scheduleSend(db, alice.id, unconfirmed, at(SEND_DELAY_MS), NOW)).toBe(false);
    expect(await reopenFailedSend(db, alice.id, unconfirmed, NOW)).toBe(true);
    expect(await getDraftForUser(db, alice.id, unconfirmed)).toMatchObject({
      status: "edited",
      error: null,
    });
  });

  it("refuses non-Gmail mailboxes", async () => {
    const { alice, thread } = await seed("outlook");
    const id = await draft(alice.id, thread.id);
    expect(await scheduleSend(db, alice.id, id, at(SEND_DELAY_MS), NOW)).toBe(false);
  });
});

describe("worker transitions", () => {
  it("claims only when due, once, then records the Gmail result", async () => {
    const { alice, thread } = await seed();
    const id = await draft(alice.id, thread.id);
    await scheduleSend(db, alice.id, id, at(SEND_DELAY_MS), NOW);
    expect(await claimSend(db, id, NOW)).toBe(false); // still inside the undo window
    expect(await claimSend(db, id, at(SEND_DELAY_MS))).toBe(true);
    expect(await claimSend(db, id, at(SEND_DELAY_MS))).toBe(false);
    expect(await undoSend(db, alice.id, id, NOW)).toBeNull(); // too late to undo

    await recordSendDraftId(db, id, "r-9");
    expect(await markSendAttempted(db, id)).toBe(true);
    expect(await markSendAttempted(db, id)).toBe(false); // a second runner backs off
    expect((await getDraftForUser(db, alice.id, id))?.error).toBe(SEND_ATTEMPTED);
    await clearSendAttempted(db, id);
    expect((await getDraftForUser(db, alice.id, id))?.error).toBeNull();

    const sentAt = at(SEND_DELAY_MS + 1_000);
    expect(await markSent(db, id, "msg-1", sentAt)).toBe(true);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "sent",
      providerDraftId: "r-9",
      providerMessageId: "msg-1",
      sentAt,
      error: null,
    });
    expect(await failSend(db, id, "send_unconfirmed")).toBe(false); // only from sending
    expect(await discardDraft(db, alice.id, id, NOW)).toBe(false);
  });

  it("fails a sending draft with a fixed code", async () => {
    const { alice, thread } = await seed();
    const id = await draft(alice.id, thread.id, { status: "sending" });
    expect(await failSend(db, id, "send_rejected")).toBe(true);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "send_failed",
      error: "send_rejected",
    });
  });
});

describe("limits, mailbox lookup and stuck sends", () => {
  it("counts sent drafts of the last hour plus scheduled and sending ones, per user", async () => {
    const { alice, bob, thread } = await seed();
    await draft(alice.id, thread.id, { status: "sent", sentAt: at(-30 * MIN) });
    await draft(alice.id, thread.id, { status: "sent", sentAt: at(-61 * MIN) });
    await draft(alice.id, thread.id, { status: "scheduled", sendAt: at(5_000) });
    await draft(alice.id, thread.id, { status: "sending" });
    await draft(alice.id, thread.id, { status: "edited" });
    expect(await countRecentSends(db, alice.id, NOW)).toBe(3);
    expect(await countRecentSends(db, bob.id, NOW)).toBe(0);
  });

  it("returns the draft's thread and mailbox only to its owner", async () => {
    const { alice, bob, box, thread } = await seed();
    const id = await draft(alice.id, thread.id);
    expect(await getDraftMailbox(db, alice.id, id)).toEqual({
      threadId: thread.id,
      mailAccountId: box.id,
      provider: "gmail",
    });
    expect(await getDraftMailbox(db, bob.id, id)).toBeNull();
  });

  it("finds overdue scheduled sends, expires very old ones and fails stuck sending ones", async () => {
    const { alice, box, thread } = await seed();
    const onTime = await draft(alice.id, thread.id, { status: "scheduled", sendAt: at(-30_000) });
    const overdue = await draft(alice.id, thread.id, { status: "scheduled", sendAt: at(-2 * MIN) });
    const ancient = await draft(alice.id, thread.id, {
      status: "scheduled",
      sendAt: at(-11 * MIN),
    });
    const stuck = await draft(alice.id, thread.id, { status: "sending", updatedAt: at(-11 * MIN) });
    const active = await draft(alice.id, thread.id, { status: "sending", updatedAt: at(-MIN) });

    expect(await listOverdueScheduledSends(db, NOW)).toEqual([
      { draftId: overdue, sendAt: at(-2 * MIN) },
    ]);
    expect(await expireScheduledSends(db, NOW)).toEqual([
      { draftId: ancient, userId: alice.id, threadId: thread.id, mailAccountId: box.id, error: "internal" },
    ]);
    expect(await failStuckSends(db, NOW)).toEqual([
      {
        draftId: stuck,
        userId: alice.id,
        threadId: thread.id,
        mailAccountId: box.id,
        error: "send_unconfirmed",
      },
    ]);
    expect((await getDraftForUser(db, alice.id, onTime))?.status).toBe("scheduled");
    expect((await getDraftForUser(db, alice.id, active))?.status).toBe("sending");
    expect(await getDraftForUser(db, alice.id, ancient)).toMatchObject({
      status: "send_failed",
      error: "internal",
    });
  });
});
```
The `updatedAt` override works because `$onUpdate` only applies to updates, not inserts.

- [ ] **Step 4: Run and see them fail**

Run: `pnpm --filter @replywise/db test:int`
Expected: FAIL (`./send` does not exist).

- [ ] **Step 5: Implement `packages/db/src/queries/send.ts`**

```ts
import type { MailProviderId } from "@replywise/core";
import { and, count, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { replyDrafts } from "../schema/ai";
import { mailAccounts, threads } from "../schema/mail";
import { SAVE_STALE_MS } from "./generation";

/** Undo window between a confirmed send and the Gmail call (spec M6 §1). */
export const SEND_DELAY_MS = 10_000;
/** Sends per user per rolling hour: sent in the window plus scheduled/sending (spec M6 §2.3). */
export const SEND_RATE_LIMIT = 20;
export const SEND_RATE_WINDOW_MS = 60 * 60 * 1000;
/** A scheduled send this far past send_at lost its job (e.g. Redis restart): re-enqueue it. */
export const SEND_OVERDUE_MS = 60 * 1000;
/** Scheduled this far past send_at, or sending this long: give up (spec M6 §2.2 step 5). */
export const SEND_STUCK_MS = 10 * 60 * 1000;
/**
 * `error` marker set just before the Gmail send call and cleared only on a rate-limit answer.
 * A run that finds it never calls Gmail again. Never shown to users.
 */
export const SEND_ATTEMPTED = "send_attempted";
/**
 * send_failed codes that prove nothing was sent, so a new confirm may schedule again: a 4xx from
 * the send call, or an M5 save error before it. `send_unconfirmed` is deliberately absent.
 */
export const RESENDABLE_FAILURES = [
  "send_rejected",
  "gmail_reauth",
  "gmail_unavailable",
  "no_recipient",
  "internal",
] as const;

const SENDABLE = ["generated", "edited", "saved"] as const;

export interface DraftMailbox {
  threadId: string;
  mailAccountId: string;
  provider: MailProviderId;
}

export interface FailedSendRow {
  draftId: string;
  userId: string;
  threadId: string;
  mailAccountId: string;
  error: string;
}

/**
 * generated|edited|saved (or send_failed with a resendable code) → scheduled. Refused while a
 * non-stale save to Gmail is in flight and for non-Gmail mailboxes. Enqueue only on true.
 */
export async function scheduleSend(
  db: DbExecutor,
  userId: string,
  draftId: string,
  sendAt: Date,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "scheduled", sendAt, error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        or(
          inArray(replyDrafts.status, [...SENDABLE]),
          and(
            eq(replyDrafts.status, "send_failed"),
            inArray(replyDrafts.error, [...RESENDABLE_FAILURES]),
          ),
        ),
        or(
          isNull(replyDrafts.saveRequestedAt),
          lt(replyDrafts.saveRequestedAt, new Date(now.getTime() - SAVE_STALE_MS)),
        ),
        sql`exists (
          select 1 from ${threads} t
          join ${mailAccounts} ma on ma.id = t.mail_account_id
          where t.id = ${replyDrafts.threadId} and ma.user_id = ${userId} and ma.provider = 'gmail'
        )`,
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/**
 * scheduled → edited. Returns the send_at it had (send_at is kept, so the caller can compute the
 * delayed job id to remove), or null when the draft was not scheduled (already claimed: too late).
 */
export async function undoSend(
  db: DbExecutor,
  userId: string,
  draftId: string,
  now: Date,
): Promise<{ sendAt: Date | null } | null> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "edited", updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        eq(replyDrafts.status, "scheduled"),
      ),
    )
    .returning({ sendAt: replyDrafts.sendAt });
  const row = rows[0];
  return row ? { sendAt: row.sendAt } : null;
}

/** Worker-only. scheduled → sending, only once the undo window is over. */
export async function claimSend(db: DbExecutor, draftId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "sending", error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.status, "scheduled"),
        lte(replyDrafts.sendAt, now),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** Worker-only. False when another run already marked it: that run owns the Gmail call. */
export async function markSendAttempted(db: DbExecutor, draftId: string): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ error: SEND_ATTEMPTED })
    .where(
      and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "sending"), isNull(replyDrafts.error)),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** Worker-only. Gmail answered with a rate limit: the request was not processed. */
export async function clearSendAttempted(db: DbExecutor, draftId: string): Promise<void> {
  await db
    .update(replyDrafts)
    .set({ error: null })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.status, "sending"),
        eq(replyDrafts.error, SEND_ATTEMPTED),
      ),
    );
}

/** Worker-only. Keeps the Gmail draft id so a retry updates that draft instead of adding one. */
export async function recordSendDraftId(
  db: DbExecutor,
  draftId: string,
  providerDraftId: string,
): Promise<void> {
  await db
    .update(replyDrafts)
    .set({ providerDraftId })
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "sending")));
}

/** Worker-only. sending → sent. */
export async function markSent(
  db: DbExecutor,
  draftId: string,
  providerMessageId: string,
  sentAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "sent", sentAt, providerMessageId, error: null, updatedAt: sentAt })
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "sending")))
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** Worker-only. sending → send_failed with a fixed code. */
export async function failSend(db: DbExecutor, draftId: string, error: string): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "send_failed", error, updatedAt: new Date() })
    .where(and(eq(replyDrafts.id, draftId), eq(replyDrafts.status, "sending")))
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

/** The user's "Edit" on a failed send: send_failed → edited (acknowledges send_unconfirmed). */
export async function reopenFailedSend(
  db: DbExecutor,
  userId: string,
  draftId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(replyDrafts)
    .set({ status: "edited", error: null, updatedAt: now })
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        eq(replyDrafts.status, "send_failed"),
      ),
    )
    .returning({ id: replyDrafts.id });
  return rows.length > 0;
}

export async function countRecentSends(db: DbExecutor, userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.userId, userId),
        or(
          gte(replyDrafts.sentAt, new Date(now.getTime() - SEND_RATE_WINDOW_MS)),
          inArray(replyDrafts.status, ["scheduled", "sending"]),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** A draft of this thread is scheduled or sending: no regenerate while it runs. */
export async function hasActiveSend(
  db: DbExecutor,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: replyDrafts.id })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.threadId, threadId),
        eq(replyDrafts.userId, userId),
        inArray(replyDrafts.status, ["scheduled", "sending"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function getDraftMailbox(
  db: DbExecutor,
  userId: string,
  draftId: string,
): Promise<DraftMailbox | null> {
  const [row] = await db
    .select({
      threadId: threads.id,
      mailAccountId: mailAccounts.id,
      provider: mailAccounts.provider,
    })
    .from(replyDrafts)
    .innerJoin(threads, eq(replyDrafts.threadId, threads.id))
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        eq(mailAccounts.userId, userId),
      ),
    );
  return row ?? null;
}

/** Worker-only. Scheduled sends whose job seems lost, not yet old enough to expire. */
export async function listOverdueScheduledSends(
  db: DbExecutor,
  now: Date,
  limit = 100,
): Promise<Array<{ draftId: string; sendAt: Date }>> {
  const rows = await db
    .select({ draftId: replyDrafts.id, sendAt: replyDrafts.sendAt })
    .from(replyDrafts)
    .where(
      and(
        eq(replyDrafts.status, "scheduled"),
        lt(replyDrafts.sendAt, new Date(now.getTime() - SEND_OVERDUE_MS)),
        gte(replyDrafts.sendAt, new Date(now.getTime() - SEND_STUCK_MS)),
      ),
    )
    .orderBy(replyDrafts.sendAt)
    .limit(limit);
  return rows.flatMap((r) => (r.sendAt ? [{ draftId: r.draftId, sendAt: r.sendAt }] : []));
}

async function failWhere(
  db: DbExecutor,
  condition: SQL,
  error: string,
  now: Date,
): Promise<FailedSendRow[]> {
  const rows = await db.execute<{
    id: string;
    user_id: string;
    thread_id: string;
    mail_account_id: string;
  }>(sql`
    update ${replyDrafts} as d
    set status = 'send_failed', error = ${error}, updated_at = ${now.toISOString()}::timestamptz
    from ${threads} t
    where t.id = d.thread_id and ${condition}
    returning d.id, d.user_id, d.thread_id, t.mail_account_id
  `);
  return [...rows].map((r) => ({
    draftId: r.id,
    userId: r.user_id,
    threadId: r.thread_id,
    mailAccountId: r.mail_account_id,
    error,
  }));
}

/** Worker-only. Never claimed within SEND_STUCK_MS of send_at: nothing reached Gmail. */
export function expireScheduledSends(db: DbExecutor, now: Date): Promise<FailedSendRow[]> {
  const cutoff = new Date(now.getTime() - SEND_STUCK_MS).toISOString();
  return failWhere(
    db,
    sql`d.status = 'scheduled' and d.send_at < ${cutoff}::timestamptz`,
    "internal",
    now,
  );
}

/** Worker-only. Sending for over SEND_STUCK_MS: it may or may not have gone out; never re-sent. */
export function failStuckSends(db: DbExecutor, now: Date): Promise<FailedSendRow[]> {
  const cutoff = new Date(now.getTime() - SEND_STUCK_MS).toISOString();
  return failWhere(
    db,
    sql`d.status = 'sending' and d.updated_at < ${cutoff}::timestamptz`,
    "send_unconfirmed",
    now,
  );
}
```
If `${replyDrafts} as d` renders a qualified name Postgres rejects, write `update reply_drafts as d` literally (the table name is fixed).

In `packages/db/src/queries/generation.ts`, guard `discardDraft` (add `notInArray` to its `where`; `notInArray` is already imported):
```ts
    .where(
      and(
        eq(replyDrafts.id, draftId),
        eq(replyDrafts.userId, userId),
        noSaveInFlight(now),
        // A confirmed send is in flight or done: the draft is locked (spec M6 §2.1).
        notInArray(replyDrafts.status, ["scheduled", "sending", "sent"]),
      ),
    )
```

In `packages/db/src/queries/audit.ts`, extend `AuditAction`:
```ts
  | "draft.saved"
  | "draft.send_scheduled"
  | "draft.send_undone"
  | "draft.sent"
  | "draft.send_failed";
```

In `packages/db/src/index.ts` add `export * from "./queries/send";` (alphabetical, after `./queries/maintenance`).

- [ ] **Step 6: Run and see them pass**

Run: `pnpm --filter @replywise/db test:int && pnpm typecheck`
Expected: PASS (db int count rises by 9; the web app's `d.status as DraftView["status"]` cast still compiles with the wider enum).

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): send state machine, send columns and search indexes (migration 0003)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The "Other" rule, Sent and Other lists, view counts and the classification skip

**Files:**
- Modify: `packages/db/src/queries/threads.ts`, `packages/db/src/queries/ai.ts`
- Test: `packages/db/src/queries/threads.int.test.ts`, `packages/db/src/queries/ai.int.test.ts`

**Interfaces:**
- Consumes: Task 1 schema (`threads.providerLabels` GIN index).
- Produces, exported from `@replywise/db`:
  - `OTHER_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"] as const`
  - `OTHER_TABS = ["promotions", "social", "updates"] as const`, `type OtherTab`, `isOtherTab(value: string): value is OtherTab`, `OTHER_TAB_LABEL: Record<OtherTab, string>` (Gmail label)
  - `otherThreadSql(threadId: AnyColumn | SQL, labels: AnyColumn | SQL): SQL` — the single definition
  - `threadListColumns` (the select shape behind `InboxThread`)
  - `listInboxThreads(db, userId, { limit?, category? })` now excludes Other threads
  - `listSentThreads(db, userId, { limit? }): Promise<InboxThread[]>`
  - `listOtherThreads(db, userId, { tab?: OtherTab | null; limit? }): Promise<InboxThread[]>`
  - `countThreadViews(db, userId): Promise<ThreadViewCounts>` with `ThreadViewCounts = { inbox: number; other: number; categories: Record<InboxCategory, number> }`
- `listThreadsPendingClassification` never returns Other threads.

Decisions recorded here (spec §4 leaves them open):
- The Other view lists `INBOX` threads only, like Gmail's tabs. Archived promotions appear only in search.
- The sync job never enqueues classification (M4 moved it to the minutely scan), so the scan is the only place to skip.

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/queries/threads.int.test.ts` (extend the import from `./threads` with `countThreadViews, listOtherThreads, listSentThreads`):
```ts
describe("Other, Sent and view counts", () => {
  async function seedViews() {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    const bobBox = await insertMailAccount(db, bob.id);
    const day = (d: number) => new Date(`2026-11-${String(d).padStart(2, "0")}T00:00:00Z`);
    const plain = await insertThread(db, box.id, {
      subject: "Plain",
      providerLabels: ["INBOX"],
      lastMessageAt: day(20),
    });
    const plainMessage = await insertMessage(db, plain.id, box.id);
    const promo = await insertThread(db, box.id, {
      subject: "Promo",
      providerLabels: ["CATEGORY_PROMOTIONS", "INBOX"],
      lastMessageAt: day(21),
    });
    const promoMessage = await insertMessage(db, promo.id, box.id);
    const social = await insertThread(db, box.id, {
      subject: "Social",
      providerLabels: ["CATEGORY_SOCIAL", "INBOX"],
      lastMessageAt: day(22),
    });
    await insertMessage(db, social.id, box.id);
    // The user wrote in it: never Other, even with a tab label.
    const answered = await insertThread(db, box.id, {
      subject: "Answered update",
      providerLabels: ["CATEGORY_UPDATES", "INBOX", "SENT"],
      lastMessageAt: day(23),
    });
    await insertMessage(db, answered.id, box.id);
    await insertMessage(db, answered.id, box.id, { isFromUser: true });
    const sentOnly = await insertThread(db, box.id, {
      subject: "Sent only",
      providerLabels: ["SENT"],
      lastMessageAt: day(24),
    });
    await insertMessage(db, sentOnly.id, box.id, { isFromUser: true });
    const bobPromo = await insertThread(db, bobBox.id, {
      subject: "Bob promo",
      providerLabels: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    await insertMessage(db, bobPromo.id, bobBox.id);
    const insight = (threadId: string, messageId: string, category: "informational" | "low_priority") =>
      upsertThreadInsight(db, {
        threadId,
        category,
        urgency: 1,
        importance: category === "informational" ? 2 : 1,
        needsReply: false,
        reasons: ["r"],
        classifiedThroughMessageId: messageId,
        aiProvider: "anthropic",
        model: "claude-opus-5-5",
        promptVersion: "classify-v1",
      });
    await insight(plain.id, plainMessage.id, "informational");
    await insight(promo.id, promoMessage.id, "low_priority");
    return { alice, bob };
  }

  it("hides Other threads from the inbox and the AI tabs", async () => {
    const { alice } = await seedViews();
    expect((await listInboxThreads(db, alice.id)).map((t) => t.subject)).toEqual([
      "Answered update",
      "Plain",
    ]);
    expect(await listInboxThreads(db, alice.id, { category: "low_priority" })).toEqual([]);
    expect(
      (await listInboxThreads(db, alice.id, { category: "informational" })).map((t) => t.subject),
    ).toEqual(["Plain"]);
  });

  it("lists Other threads newest first, filtered by tab and scoped to the user", async () => {
    const { alice, bob } = await seedViews();
    expect((await listOtherThreads(db, alice.id)).map((t) => t.subject)).toEqual([
      "Social",
      "Promo",
    ]);
    expect(
      (await listOtherThreads(db, alice.id, { tab: "promotions" })).map((t) => t.subject),
    ).toEqual(["Promo"]);
    expect(await listOtherThreads(db, alice.id, { tab: "updates" })).toEqual([]);
    expect((await listOtherThreads(db, bob.id)).map((t) => t.subject)).toEqual(["Bob promo"]);
  });

  it("lists SENT threads", async () => {
    const { alice } = await seedViews();
    expect((await listSentThreads(db, alice.id)).map((t) => t.subject)).toEqual([
      "Sent only",
      "Answered update",
    ]);
  });

  it("counts views with the same rule", async () => {
    const { alice } = await seedViews();
    expect(await countThreadViews(db, alice.id)).toEqual({
      inbox: 2,
      other: 2,
      categories: {
        urgent: 0,
        important: 0,
        needs_reply: 0,
        informational: 1,
        low_priority: 0,
      },
    });
  });
});
```

Append to `packages/db/src/queries/ai.int.test.ts`, inside `describe("listThreadsPendingClassification branches", …)`:
```ts
  it("never returns Other threads, but does return a tab thread the user wrote in", async () => {
    const alice = await insertUser(db);
    const box = await insertMailAccount(db, alice.id);
    await validKey(alice.id);
    const promo = await insertThread(db, box.id, {
      lastMessageAt: new Date(now.getTime() - DAY),
      providerLabels: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    await insertMessage(db, promo.id, box.id, { sentAt: new Date(now.getTime() - DAY) });
    expect(await listThreadsPendingClassification(db, since)).toEqual([]);

    const replied = await insertThread(db, box.id, {
      lastMessageAt: new Date(now.getTime() - DAY),
      providerLabels: ["CATEGORY_UPDATES", "INBOX"],
    });
    await insertMessage(db, replied.id, box.id, {
      sentAt: new Date(now.getTime() - 3 * DAY),
      isFromUser: true,
    });
    const latest = await insertMessage(db, replied.id, box.id, {
      sentAt: new Date(now.getTime() - DAY),
    });
    expect(await listThreadsPendingClassification(db, since)).toEqual([
      { threadId: replied.id, latestMessageId: latest.id, credentialVersion: expect.any(Number) },
    ]);
  });
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @replywise/db test:int`
Expected: FAIL (`listOtherThreads`, `listSentThreads`, `countThreadViews` missing; the promo thread is still in the inbox and in the scan).

- [ ] **Step 3: Implement**

Replace the top of `packages/db/src/queries/threads.ts` (imports through `listInboxThreads`) with:
```ts
import {
  type EmailAddress,
  INBOX_CATEGORIES,
  type InboxCategory,
  type MailProviderId,
} from "@replywise/core";
import { type AnyColumn, and, arrayContains, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { threadInsights } from "../schema/ai";
import { mailAccounts, messages, threads } from "../schema/mail";

export interface InboxThread {
  id: string;
  subject: string;
  snippet: string;
  participants: EmailAddress[];
  lastMessageAt: Date;
  messageCount: number;
  isUnread: boolean;
  mailAccountId: string;
  mailboxEmail: string;
  category: InboxCategory | null;
  urgency: number | null;
  importance: number | null;
  reasons: string[] | null;
}

/** Gmail tab labels that make a thread "Other" (spec M6 §4). */
export const OTHER_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"] as const;
export const OTHER_TABS = ["promotions", "social", "updates"] as const;
export type OtherTab = (typeof OTHER_TABS)[number];
export const OTHER_TAB_LABEL: Record<OtherTab, (typeof OTHER_LABELS)[number]> = {
  promotions: "CATEGORY_PROMOTIONS",
  social: "CATEGORY_SOCIAL",
  updates: "CATEGORY_UPDATES",
};

export function isOtherTab(value: string): value is OtherTab {
  return (OTHER_TABS as readonly string[]).includes(value);
}

/**
 * The one definition of "Other" (spec M6 §4): Gmail filed the thread under Promotions, Social or
 * Updates, and no message in it is from the user. Every list, count and scan uses this helper.
 * Pass columns (`threads.id`) or raw aliases (sql`t.id`) for queries that alias the table.
 */
export function otherThreadSql(threadId: AnyColumn | SQL, labels: AnyColumn | SQL): SQL {
  return sql`(${labels} && array['CATEGORY_PROMOTIONS','CATEGORY_SOCIAL','CATEGORY_UPDATES']::text[]
    and not exists (
      select 1 from ${messages} om where om.thread_id = ${threadId} and om.is_from_user = true
    ))`;
}

const notOther = () => sql`not ${otherThreadSql(threads.id, threads.providerLabels)}`;
const inInbox = () => arrayContains(threads.providerLabels, ["INBOX"]);

/** Select shape of `InboxThread` (threads + mailbox address + optional insight). */
export const threadListColumns = {
  id: threads.id,
  subject: threads.subject,
  snippet: threads.snippet,
  participants: threads.participants,
  lastMessageAt: threads.lastMessageAt,
  messageCount: threads.messageCount,
  isUnread: threads.isUnread,
  mailAccountId: threads.mailAccountId,
  mailboxEmail: mailAccounts.emailAddress,
  category: threadInsights.category,
  urgency: threadInsights.urgency,
  importance: threadInsights.importance,
  reasons: threadInsights.reasons,
};

function selectThreads(
  db: DbExecutor,
  userId: string,
  conditions: SQL[],
  limit: number,
): Promise<InboxThread[]> {
  return db
    .select(threadListColumns)
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .leftJoin(threadInsights, eq(threadInsights.threadId, threads.id))
    .where(and(eq(mailAccounts.userId, userId), ...conditions))
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
}

/** Main inbox and AI tabs: INBOX threads that are not Other. */
export async function listInboxThreads(
  db: DbExecutor,
  userId: string,
  options: { limit?: number; category?: InboxCategory } = {},
): Promise<InboxThread[]> {
  const conditions: SQL[] = [inInbox(), notOther()];
  if (options.category) conditions.push(eq(threadInsights.category, options.category));
  return selectThreads(db, userId, conditions, options.limit ?? 50);
}

/** Threads with a message the user sent (Gmail label SENT). */
export async function listSentThreads(
  db: DbExecutor,
  userId: string,
  options: { limit?: number } = {},
): Promise<InboxThread[]> {
  return selectThreads(
    db,
    userId,
    [arrayContains(threads.providerLabels, ["SENT"])],
    options.limit ?? 50,
  );
}

/** INBOX threads that are Other, optionally one Gmail tab. */
export async function listOtherThreads(
  db: DbExecutor,
  userId: string,
  options: { tab?: OtherTab | null; limit?: number } = {},
): Promise<InboxThread[]> {
  const conditions: SQL[] = [inInbox(), otherThreadSql(threads.id, threads.providerLabels)];
  if (options.tab) {
    conditions.push(arrayContains(threads.providerLabels, [OTHER_TAB_LABEL[options.tab]]));
  }
  return selectThreads(db, userId, conditions, options.limit ?? 50);
}

export interface ThreadViewCounts {
  inbox: number;
  other: number;
  categories: Record<InboxCategory, number>;
}

/** Thread counts for the nav, with exactly the list queries' rules. */
export async function countThreadViews(db: DbExecutor, userId: string): Promise<ThreadViewCounts> {
  const rows = await db
    .select({
      other: sql<boolean>`${otherThreadSql(threads.id, threads.providerLabels)}`,
      category: threadInsights.category,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .leftJoin(threadInsights, eq(threadInsights.threadId, threads.id))
    .where(and(eq(mailAccounts.userId, userId), inInbox()))
    .groupBy(sql`1`, sql`2`);
  const categories = Object.fromEntries(INBOX_CATEGORIES.map((c) => [c, 0])) as Record<
    InboxCategory,
    number
  >;
  const counts: ThreadViewCounts = { inbox: 0, other: 0, categories };
  for (const row of rows) {
    if (row.other) {
      counts.other += row.n;
      continue;
    }
    counts.inbox += row.n;
    if (row.category) counts.categories[row.category] += row.n;
  }
  return counts;
}
```
Keep `ThreadDetail` and `getThreadForUser` below unchanged.

In `packages/db/src/queries/ai.ts`, import the helper and add one condition to the scan's `where` (after the `INBOX` line):
```ts
import { otherThreadSql } from "./threads";
```
```sql
      and t.provider_labels @> array['INBOX']::text[]
      and not ${otherThreadSql(sql`t.id`, sql`t.provider_labels`)}
```
Update the function's doc comment: "…whose newest message is not from the user, that are not Other (spec M6 §4), that are not yet classified…".

- [ ] **Step 4: Run and see them pass**

Run: `pnpm --filter @replywise/db test:int && pnpm --filter @replywise/sync test:int`
Expected: PASS (the sync suite uses `listInboxThreads` and must stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): Other rule for Gmail tabs, Sent and Other lists, view counts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Local search query

**Files:**
- Create: `packages/db/src/queries/search.ts`, `packages/db/src/queries/search.test.ts`, `packages/db/src/queries/search.int.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: Task 1 `threads.participantsText` and trigram indexes; Task 2 `otherThreadSql`, `threadListColumns`, `InboxThread`.
- Produces, exported from `@replywise/db`:
  - `SEARCH_MIN_CHARS = 2`, `SEARCH_MAX_CHARS = 200`
  - `escapeLikePattern(input: string): string` (escapes `\`, `%`, `_` with a backslash)
  - `type ThreadLocation = "inbox" | "other" | "sent" | "archived"`
  - `interface SearchThread extends InboxThread { location: ThreadLocation }`
  - `searchThreads(db, userId, query: string, limit?: number): Promise<SearchThread[]>` (newest first, default limit 50, `[]` below 2 characters)

- [ ] **Step 1: Write the failing tests**

`packages/db/src/queries/search.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./search";

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLikePattern("50%_off\\now")).toBe("50\\%\\_off\\\\now");
  });
  it("leaves ordinary text alone", () => {
    expect(escapeLikePattern("Ada Lovelace <ada@x.com>")).toBe("Ada Lovelace <ada@x.com>");
  });
});
```

`packages/db/src/queries/search.int.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import { searchThreads } from "./search";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function seed() {
  const alice = await insertUser(db);
  const bob = await insertUser(db);
  const box = await insertMailAccount(db, alice.id);
  const bobBox = await insertMailAccount(db, bob.id);
  const make = async (
    mailAccountId: string,
    subject: string,
    labels: string[],
    extra: { snippet?: string; name?: string; day: number },
  ) => {
    const thread = await insertThread(db, mailAccountId, {
      subject,
      snippet: extra.snippet ?? "",
      participants: [{ name: extra.name ?? "Someone", address: "someone@example.com" }],
      providerLabels: labels,
      lastMessageAt: new Date(`2026-11-${String(extra.day).padStart(2, "0")}T00:00:00Z`),
    });
    await insertMessage(db, thread.id, mailAccountId);
    return thread;
  };
  await make(box.id, "Contract to sign", ["INBOX"], { day: 20 });
  await make(box.id, "Weekly sale", ["CATEGORY_PROMOTIONS", "INBOX"], {
    snippet: "Contract prices drop",
    day: 21,
  });
  await make(box.id, "Proposal", ["SENT"], { name: "Ada CONTRACTOR", day: 22 });
  await make(box.id, "Old thing", [], { snippet: "contract archive", day: 19 });
  await make(box.id, "100% done_now", ["INBOX"], { day: 18 });
  await make(bobBox.id, "Bob contract", ["INBOX"], { day: 23 });
  return { alice, bob };
}

describe("searchThreads", () => {
  it("matches subject, snippet and participants case-insensitively, newest first, with locations", async () => {
    const { alice } = await seed();
    const results = await searchThreads(db, alice.id, "contract");
    expect(results.map((r) => [r.subject, r.location])).toEqual([
      ["Proposal", "sent"],
      ["Weekly sale", "other"],
      ["Contract to sign", "inbox"],
      ["Old thing", "archived"],
    ]);
  });

  it("is scoped to the user", async () => {
    const { bob } = await seed();
    expect((await searchThreads(db, bob.id, "contract")).map((r) => r.subject)).toEqual([
      "Bob contract",
    ]);
  });

  it("treats % and _ in the query literally and ignores queries under 2 characters", async () => {
    const { alice } = await seed();
    expect((await searchThreads(db, alice.id, "100%")).map((r) => r.subject)).toEqual([
      "100% done_now",
    ]);
    // Unescaped, "%%" and "n_w" would match everything / "now".
    expect(await searchThreads(db, alice.id, "%%")).toEqual([]);
    expect(await searchThreads(db, alice.id, "n_w")).toEqual([]);
    expect((await searchThreads(db, alice.id, "e_n")).map((r) => r.subject)).toEqual([
      "100% done_now",
    ]);
    expect(await searchThreads(db, alice.id, " c ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @replywise/db test && pnpm --filter @replywise/db test:int`
Expected: FAIL (`./search` does not exist).

- [ ] **Step 3: Implement `packages/db/src/queries/search.ts`**

```ts
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { threadInsights } from "../schema/ai";
import { mailAccounts, threads } from "../schema/mail";
import { type InboxThread, otherThreadSql, threadListColumns } from "./threads";

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 200;

export type ThreadLocation = "inbox" | "other" | "sent" | "archived";

export interface SearchThread extends InboxThread {
  location: ThreadLocation;
}

/** Escapes LIKE metacharacters so user input matches literally (backslash is the default escape). */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

/**
 * Case-insensitive search over subject, snippet and participants of every synced thread the
 * user owns (inbox, sent, other, imported). Bodies are not searched (spec M6 §5.1).
 */
export async function searchThreads(
  db: DbExecutor,
  userId: string,
  query: string,
  limit = 50,
): Promise<SearchThread[]> {
  const q = query.trim().slice(0, SEARCH_MAX_CHARS);
  if (q.length < SEARCH_MIN_CHARS) return [];
  const pattern = `%${escapeLikePattern(q)}%`;
  const rows = await db
    .select({
      ...threadListColumns,
      inInbox: sql<boolean>`${threads.providerLabels} @> array['INBOX']::text[]`,
      inSent: sql<boolean>`${threads.providerLabels} @> array['SENT']::text[]`,
      other: sql<boolean>`${otherThreadSql(threads.id, threads.providerLabels)}`,
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .leftJoin(threadInsights, eq(threadInsights.threadId, threads.id))
    .where(
      and(
        eq(mailAccounts.userId, userId),
        or(
          ilike(threads.subject, pattern),
          ilike(threads.snippet, pattern),
          ilike(threads.participantsText, pattern),
        ),
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
  return rows.map(({ inInbox, inSent, other, ...thread }) => ({
    ...thread,
    location: inInbox ? (other ? "other" : "inbox") : inSent ? "sent" : "archived",
  }));
}
```
Add `export * from "./queries/search";` to `packages/db/src/index.ts`.

- [ ] **Step 4: Run and see them pass**

Run: `pnpm --filter @replywise/db test && pnpm --filter @replywise/db test:int && pnpm --filter @replywise/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): local thread search over subject, snippet and participants" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reply target helpers, the Gmail send client, Gmail metadata reads and the guard

**Files:**
- Modify: `packages/core/src/mail.ts`, `packages/core/src/mail.test.ts`
- Modify: `packages/mail/src/mime/replyMime.ts` (use core `replySubject`)
- Create: `packages/mail/src/gmail-send.ts`, `packages/mail/src/gmail-send.test.ts`
- Modify: `packages/mail/src/gmail-api.ts`, `packages/mail/src/gmail-api.test.ts`, `packages/mail/src/index.ts`, `packages/mail/package.json`
- Modify: `packages/mail/src/no-send.test.ts`
- Modify: `packages/sync/src/testing.ts` (the fake implements the new `GmailApi` method)
- Create: `apps/worker/src/jobs/send-draft.ts` (a two-line stub, replaced in Task 6, so the guard is green at every commit)

**Interfaces:**
- Produces:
  - `@replywise/core`: `pickReplyTarget<M extends { id: string; isFromUser: boolean }>(messages: readonly M[], forMessageId: string | null): M | null` (messages oldest first) and `replySubject(subject: string): string`.
  - `@replywise/mail/gmail-send` (package subpath; **never** re-exported as a value): `createGmailSendApi(accessToken: string, options?: { fetch?: FetchLike }): GmailSendApi`.
  - `@replywise/mail` (types only): `GmailSendApi = { sendDraft(providerDraftId: string): Promise<{ messageId: string; threadId: string | null }> }`, `GmailSendFactory = (accessToken: string) => GmailSendApi`.
  - `GmailApi.getThreadMetadata(threadId: string): Promise<GmailThreadMetadata | null>` with `GmailThreadMetadata = { providerThreadId: string; subject: string; from: EmailAddress; date: Date; snippet: string }` (subject of the first message; sender, date and snippet of the newest).
  - `GmailApiOptions.baseUrl?: string` (origin override, used only for the e2e fake).
  - `GMAIL_COST.getThreadMetadata = 20`.
  - `createFakeGmail` gains `getThreadMetadata` and `calls.getThreadMetadata: string[]`.
- Guard change: `/\/send\b/` becomes `/\/send(?![\w-])/`. Every `…/send` endpoint is still caught, but the module path `./jobs/send-draft` (fixed by the spec, imported by `main.ts`) is not.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/mail.test.ts` (extend the import with `pickReplyTarget, replySubject`):
```ts
describe("pickReplyTarget", () => {
  const msgs = [
    { id: "m1", isFromUser: false },
    { id: "m2", isFromUser: true },
    { id: "m3", isFromUser: false },
    { id: "m4", isFromUser: true },
  ];
  it("answers the pinned message when it is not the user's own", () => {
    expect(pickReplyTarget(msgs, "m1")?.id).toBe("m1");
  });
  it("falls back to the newest inbound message", () => {
    expect(pickReplyTarget(msgs, null)?.id).toBe("m3");
    expect(pickReplyTarget(msgs, "m2")?.id).toBe("m3");
    expect(pickReplyTarget(msgs, "gone")?.id).toBe("m3");
  });
  it("returns null when only the user wrote", () => {
    expect(pickReplyTarget([{ id: "m1", isFromUser: true }], null)).toBeNull();
  });
});

describe("replySubject", () => {
  it("adds Re: once and flattens line breaks", () => {
    expect(replySubject("Contract")).toBe("Re: Contract");
    expect(replySubject("RE: Contract")).toBe("RE: Contract");
    expect(replySubject("A\r\nB ")).toBe("Re: A B");
  });
});
```

Create `packages/mail/src/gmail-send.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createGmailSendApi } from "./gmail-send";
import { ProviderHttpError } from "./http";
import type { FetchLike } from "./types";

function fakeFetch(status: number, body: unknown = {}) {
  const calls: Array<{ method: string | undefined; url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      method: init?.method,
      url: String(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

describe("createGmailSendApi", () => {
  it("sends an existing draft by id and returns the Gmail message id", async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: "msg-1", threadId: "t1", labelIds: ["SENT"] });
    const api = createGmailSendApi("tok", { fetch: fetchImpl });
    await expect(api.sendDraft("r-1")).resolves.toEqual({ messageId: "msg-1", threadId: "t1" });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        body: { id: "r-1" },
      },
    ]);
  });

  it("marks a 429 as rate limited and a 400 as a plain failure", async () => {
    const limited = createGmailSendApi("tok", { fetch: fakeFetch(429).fetchImpl });
    await expect(limited.sendDraft("r-1")).rejects.toMatchObject({ status: 429, rateLimited: true });
    const rejected = createGmailSendApi("tok", { fetch: fakeFetch(400).fetchImpl });
    await expect(rejected.sendDraft("r-1")).rejects.toMatchObject({
      status: 400,
      rateLimited: false,
    });
  });

  it("treats a success without a message id as a failure", async () => {
    const api = createGmailSendApi("tok", { fetch: fakeFetch(200, {}).fetchImpl });
    await expect(api.sendDraft("r-1")).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("reports a timeout as status 0", async () => {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    const api = createGmailSendApi("tok", { fetch: fetchImpl });
    await expect(api.sendDraft("r-1")).rejects.toMatchObject({ status: 0 });
  });
});
```

Append to `packages/mail/src/gmail-api.test.ts`, inside `describe("createGmailApi", …)`:
```ts
  it("reads thread metadata: first subject, newest sender, date and snippet", async () => {
    const meta = (id: string, internalDate: string, from: string, subject: string, snippet: string) => ({
      id,
      threadId: "t1",
      internalDate,
      snippet,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: from },
          { name: "Subject", value: subject },
        ],
      },
    });
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          id: "t1",
          messages: [
            meta("m2", "2000", "Bob <bob@x.com>", "Re: Invoice", "newest"),
            meta("m1", "1000", "ada@x.com", "Invoice", "first"),
          ],
        },
      },
      { status: 404, body: { error: { code: 404 } } },
    ]);
    const api = createGmailApi("tok", { fetch: fetchImpl, sleep: noSleep });
    expect(await api.getThreadMetadata("t1")).toEqual({
      providerThreadId: "t1",
      subject: "Invoice",
      from: { name: "Bob", address: "bob@x.com" },
      date: new Date(2000),
      snippet: "newest",
    });
    expect(calls[0]?.url.pathname).toBe("/gmail/v1/users/me/threads/t1");
    expect(calls[0]?.url.searchParams.get("format")).toBe("metadata");
    expect(calls[0]?.url.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "From", "Date"]);
    expect(await api.getThreadMetadata("gone")).toBeNull();
  });

  it("talks to a configured origin instead of Google", async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { threads: [] } }]);
    const api = createGmailApi("tok", {
      fetch: fetchImpl,
      sleep: noSleep,
      baseUrl: "http://127.0.0.1:4010/",
    });
    await api.listThreadIds({ query: "x", maxResults: 1 });
    expect(calls[0]?.url.origin).toBe("http://127.0.0.1:4010");
    expect(calls[0]?.url.pathname).toBe("/gmail/v1/users/me/threads");
  });
```

Replace `packages/mail/src/no-send.test.ts` entirely:
```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../../..");

// Every package and app that talks to mail providers.
const ROOTS = [
  join(import.meta.dirname, "."),
  join(import.meta.dirname, "../../mailbox/src"),
  join(import.meta.dirname, "../../sync/src"),
  join(import.meta.dirname, "../../ai/src"),
  join(import.meta.dirname, "../../../apps/worker/src"),
].filter((dir) => existsSync(dir));

/** Spec M6 §2.3: the only file that may contain Gmail's send-draft URL. */
const SEND_MODULE = "packages/mail/src/gmail-send.ts";
/** Spec M6 §2.3: the only file that may import the send client. */
const SEND_IMPORTER = "apps/worker/src/jobs/send-draft.ts";
const SEND_URL_PATH = "drafts/send";

// Spec §8 + M6 §2.3: no other send capability anywhere.
const FORBIDDEN = [
  /sendMail/i,
  /\/send(?![\w-])/i,
  /messages\.send/i,
  /drafts\/send/i,
  /mail\.send/i,
  /drafts\.send/i,
  /\/(reply|replyAll|forward)\b/i,
];

const posix = (file: string) => relative(REPO, file).split(sep).join("/");

function sourceFiles(dir: string, extensions: string[]): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter(
      (file) =>
        extensions.some((ext) => file.endsWith(ext)) &&
        !/\.test\.tsx?$/.test(file) &&
        !file.includes("node_modules"),
    )
    .map((file) => join(dir, file));
}

/** Every `src` tree under apps/ and packages/. */
function allSourceDirs(): string[] {
  return ["apps", "packages"].flatMap((top) =>
    readdirSync(join(REPO, top))
      .map((name) => join(REPO, top, name, "src"))
      .filter((dir) => existsSync(dir)),
  );
}

describe("no-send guard", () => {
  it("blocks reply/forward endpoints but allows createReply drafts", () => {
    const reply = FORBIDDEN[FORBIDDEN.length - 1] as RegExp;
    expect(reply.test("/me/messages/x/reply")).toBe(true);
    expect(reply.test("/me/messages/x/createReply")).toBe(false);
  });

  it("blocks every /send endpoint but not module paths that start with send-", () => {
    const send = FORBIDDEN[1] as RegExp;
    expect(send.test("users/me/messages/send")).toBe(true);
    expect(send.test("users/me/drafts/send?x=1")).toBe(true);
    expect(send.test("/me/send")).toBe(true);
    expect(send.test('from "./jobs/send-draft"')).toBe(false);
  });

  it("finds no send endpoints outside the one allowlisted Gmail send module", () => {
    const sources = ROOTS.flatMap((dir) => sourceFiles(dir, [".ts"]));
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.flatMap((file) => {
      let text = readFileSync(file, "utf8");
      // The allowlist covers exactly the drafts/send path in exactly one file.
      if (posix(file) === SEND_MODULE) text = text.replaceAll(SEND_URL_PATH, "");
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map((p) => `${posix(file)}: ${p}`);
    });
    expect(offenders).toEqual([]);
    expect(readFileSync(join(REPO, SEND_MODULE), "utf8")).toContain(SEND_URL_PATH);
  });

  it("lets only the worker send job create the Gmail send client", () => {
    const files = allSourceDirs().flatMap((dir) => sourceFiles(dir, [".ts", ".tsx"]));
    const users = files
      .filter((file) => readFileSync(file, "utf8").includes("createGmailSendApi"))
      .map(posix)
      .sort();
    expect(users).toEqual([SEND_IMPORTER, SEND_MODULE].sort());
    expect(readFileSync(join(REPO, SEND_IMPORTER), "utf8")).toContain(
      'from "@replywise/mail/gmail-send"',
    );
    // Anyone else may reference the module for types only.
    const valueRefs = files
      .filter((file) => posix(file) !== SEND_IMPORTER)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => /gmail-send["']/.test(line) && !/^\s*(export|import) type\b/.test(line))
          .map((line) => `${posix(file)}: ${line.trim()}`),
      );
    expect(valueRefs).toEqual([]);
  });

  it("keeps every send endpoint out of the web app", () => {
    const patterns = [
      /sendMail/i,
      /messages\/send/i,
      /drafts\/send/i,
      /messages\.send/i,
      /drafts\.send/i,
    ];
    const offenders = sourceFiles(join(REPO, "apps/web/src"), [".ts", ".tsx"]).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return patterns.filter((p) => p.test(text)).map((p) => `${posix(file)}: ${p}`);
    });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @replywise/core test && pnpm --filter @replywise/mail test`
Expected: FAIL (missing `pickReplyTarget`, `./gmail-send`, `getThreadMetadata`, `baseUrl`; the single-importer test fails).

- [ ] **Step 3: Implement**

Append to `packages/core/src/mail.ts`:
```ts
/**
 * The message a reply answers (messages oldest first): the pinned one if it is not the user's
 * own, else the newest message from someone else. Shared by the worker and the send dialog.
 */
export function pickReplyTarget<M extends { id: string; isFromUser: boolean }>(
  messages: readonly M[],
  forMessageId: string | null,
): M | null {
  const pinned = forMessageId
    ? messages.find((m) => m.id === forMessageId && !m.isFromUser)
    : undefined;
  return pinned ?? messages.findLast((m) => !m.isFromUser) ?? null;
}

/** "Re: <subject>" unless it already starts with Re:, on one line. */
export function replySubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, " ").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
```

In `packages/mail/src/mime/replyMime.ts`, delete the local `replySubject` function and import it instead: `import { type EmailAddress, replySubject } from "@replywise/core";` (merge with the file's existing `@replywise/core` import). The existing `replyMime.test.ts` must stay green unchanged.

Create `packages/mail/src/gmail-send.ts`:
```ts
import { ProviderHttpError, requestJson } from "./http";
import type { FetchLike } from "./types";

const SEND_DRAFT_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send";
const SEND_DRAFT_PATH = "/gmail/v1/users/me/drafts/send";

/**
 * The ONLY code in Replywise that can deliver mail (spec M6 §2.3): it sends a Gmail draft the user
 * confirmed. One call, no retries here; the worker's send job owns every retry decision. The
 * no-send guard test enforces that the worker send job is its only importer.
 */
export interface GmailSendApi {
  sendDraft(providerDraftId: string): Promise<{ messageId: string; threadId: string | null }>;
}

export type GmailSendFactory = (accessToken: string) => GmailSendApi;

export function createGmailSendApi(
  accessToken: string,
  options: { fetch?: FetchLike } = {},
): GmailSendApi {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async sendDraft(providerDraftId) {
      const body = await requestJson(fetchImpl, "POST", SEND_DRAFT_URL, accessToken, {
        id: providerDraftId,
      });
      if (typeof body.id !== "string" || body.id === "") {
        throw new ProviderHttpError(200, SEND_DRAFT_PATH);
      }
      return {
        messageId: body.id,
        threadId: typeof body.threadId === "string" ? body.threadId : null,
      };
    },
  };
}
```

`packages/mail/package.json` `exports`:
```json
  "exports": {
    ".": "./src/index.ts",
    "./gmail-send": "./src/gmail-send.ts"
  },
```
`packages/mail/src/index.ts`, add (types only; the factory stays behind the subpath):
```ts
export type { GmailSendApi, GmailSendFactory } from "./gmail-send";
```

`packages/mail/src/gmail-api.ts`:
- Add `import type { EmailAddress } from "@replywise/core";`.
- Replace `const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";` with `const GMAIL_ORIGIN = "https://gmail.googleapis.com";`.
- Add to `GmailApiOptions`:
```ts
  /** Origin override (no path), e.g. a local fake for e2e. Defaults to Google. */
  baseUrl?: string;
```
- Add the metadata type, and the method to `interface GmailApi` (after `getThread`):
```ts
/** Search-result view of a thread: no bodies. */
export interface GmailThreadMetadata {
  providerThreadId: string;
  /** Subject of the first message. */
  subject: string;
  /** Sender, date and snippet of the newest message. */
  from: EmailAddress;
  date: Date;
  snippet: string;
}
```
```ts
  getThreadMetadata(threadId: string): Promise<GmailThreadMetadata | null>;
```
- `GMAIL_COST` becomes `{ profile: 10, listThreads: 100, getThread: 120, getThreadMetadata: 20, listHistory: 20 }`.
- In `createGmailApi`, right after the option defaults:
```ts
  const base = `${(options.baseUrl ?? GMAIL_ORIGIN).replace(/\/+$/, "")}/gmail/v1/users/me`;
```
  and replace every `${BASE}` with `${base}` (profile, threads, threads/{id}, history).
- Add the method after `getThread`:
```ts
    async getThreadMetadata(threadId) {
      const url = new URL(`${base}/threads/${encodeURIComponent(threadId)}`);
      url.searchParams.set("format", "metadata");
      for (const header of ["Subject", "From", "Date"]) {
        url.searchParams.append("metadataHeaders", header);
      }
      let body: Record<string, unknown>;
      try {
        body = await get(url, GMAIL_COST.getThreadMetadata);
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) return null;
        throw error;
      }
      const parsed = (Array.isArray(body.messages) ? (body.messages as GmailMessageResource[]) : [])
        .map(parseGmailMessage)
        .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
      const first = parsed[0];
      const last = parsed.at(-1);
      if (!first || !last) return null;
      return {
        providerThreadId: threadId,
        subject: first.subject,
        from: last.from,
        date: last.sentAt,
        snippet: last.snippet,
      };
    },
```

`packages/sync/src/testing.ts`: add `getThreadMetadata: [] as string[]` to `calls`, and to `api`:
```ts
    async getThreadMetadata(threadId) {
      fail();
      calls.getThreadMetadata.push(threadId);
      const sorted = [...(threads[threadId] ?? [])].sort(
        (a, b) => a.sentAt.getTime() - b.sentAt.getTime(),
      );
      const first = sorted[0];
      const last = sorted.at(-1);
      if (!first || !last) return null;
      return {
        providerThreadId: threadId,
        subject: first.subject,
        from: last.from,
        date: last.sentAt,
        snippet: last.snippet,
      };
    },
```

Create the importer stub `apps/worker/src/jobs/send-draft.ts` (Task 6 replaces the whole file; nothing imports it yet):
```ts
import { createGmailSendApi } from "@replywise/mail/gmail-send";

/** Replaced by the send job in Task 6. The guard requires this file to be the only importer. */
export const sendClientFor = (accessToken: string) => createGmailSendApi(accessToken);
```

- [ ] **Step 4: Run and see them pass**

Run: `pnpm --filter @replywise/core test && pnpm --filter @replywise/mail test && pnpm --filter @replywise/mail typecheck && pnpm --filter @replywise/sync typecheck && pnpm --filter @replywise/worker typecheck`
Expected: PASS, including all five guard tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/mail packages/sync/src/testing.ts apps/worker/src/jobs/send-draft.ts
git commit -m "feat(mail): Gmail send client behind a guarded subpath, thread metadata reads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sync: Sent in the backfill, Gmail search and thread import

**Files:**
- Modify: `packages/sync/src/sync-mailbox.ts`, `packages/sync/src/sync-mailbox.int.test.ts`
- Create: `packages/sync/src/gmail-search.ts`, `packages/sync/src/gmail-search.int.test.ts`
- Modify: `packages/sync/src/index.ts`, `packages/db/src/queries/sync.ts`

**Interfaces:**
- Consumes: Task 4 `GmailApi.getThreadMetadata` and `createFakeGmail`; `getValidAccessToken`, `MailAccountNotFoundError`, `ReauthRequiredError`, `clock` (mailbox); `persistThreads`, `mapWithConcurrency` (sync); `getMailAccountForUser`, `MailAccount` (db); Task 2 `listSentThreads`.
- Produces:
  - `BACKFILL_QUERY = "(in:inbox OR in:sent) newer_than:30d"` (cap unchanged)
  - `@replywise/db`: `findLocalThreadIds(db, mailAccountId, providerThreadIds: string[]): Promise<Map<string, string>>` (provider id → local id; caller verified ownership)
  - `@replywise/sync`: `GMAIL_QUERY_MAX_CHARS = 200`, `GMAIL_SEARCH_MAX_RESULTS = 20`, `interface GmailSearchResult { providerThreadId: string; subject: string; from: EmailAddress; date: Date; snippet: string; localThreadId: string | null }`
  - `searchGmailThreads(deps: SyncDeps, input: { userId: string; mailAccountId: string; query: string }): Promise<GmailSearchResult[]>`
  - `importThread(deps: SyncDeps, input: { userId: string; mailAccountId: string; providerThreadId: string }): Promise<string | null>` (local thread id; null when Gmail has no non-draft message for it)
  - Both throw `MailAccountNotFoundError` for a mailbox the user does not own or that is not Gmail, and `ReauthRequiredError` when it needs reconnecting.

- [ ] **Step 1: Write the failing tests**

In `packages/sync/src/sync-mailbox.int.test.ts`:
- Change the backfill query assertion to `expect(gmail.calls.listThreadIds[0]?.query).toBe("(in:inbox OR in:sent) newer_than:30d");`.
- Add `listSentThreads` to the `@replywise/db` import and append the test below (`connectedGmail` and `syncDeps(base, gmail)` are the file's existing helpers).
```ts
describe("sent mail", () => {
  it("stores sent-only threads, lists them in Sent and never queues them for classification", async () => {
    const { base, userId, mailAccountId, encryptor } = await connectedGmail();
    await saveAiCredential(db, {
      userId,
      keyCiphertext: await encryptor.encrypt("sk-ant-x", aad.aiCredential(userId, "anthropic")),
      keyHint: "x",
      status: "valid",
      lastValidatedAt: T0,
    });
    const gmail = createFakeGmail({
      threads: {
        s1: [
          fakeMessage({
            providerMessageId: "s1m1",
            providerThreadId: "s1",
            from: { name: "Me", address: "me@gmail.com" },
            to: [{ name: null, address: "client@example.com" }],
            subject: "Proposal",
            labelIds: ["SENT"],
            sentAt: new Date("2026-11-16T00:00:00Z"),
          }),
        ],
      },
    });
    await syncMailbox(syncDeps(base, gmail), mailAccountId);
    expect((await listSentThreads(db, userId)).map((t) => t.subject)).toEqual(["Proposal"]);
    expect(await listInboxThreads(db, userId)).toEqual([]);
    expect(
      await listThreadsPendingClassification(db, new Date("2026-11-01T00:00:00Z")),
    ).toEqual([]);
  });
});
```

Create `packages/sync/src/gmail-search.int.test.ts`:
```ts
import { type Db, mailAccounts, messages, threads } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import {
  completeConnect,
  MailAccountNotFoundError,
  ReauthRequiredError,
  startConnect,
} from "@replywise/mailbox";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SyncDeps } from "./deps";
import { importThread, searchGmailThreads } from "./gmail-search";
import { syncMailbox } from "./sync-mailbox";
import { createFakeGmail, fakeMessage } from "./testing";

const T0 = new Date("2026-11-25T12:00:00Z");
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function connected() {
  const provider = createFakeProvider("gmail", { email: "me@gmail.com" });
  const encryptor = testEncryptor();
  const user = await insertUser(db);
  const base = { db, encryptor, providers: { gmail: provider.provider }, now: () => T0 };
  const url = await startConnect(base, {
    userId: user.id,
    provider: "gmail",
    redirectUri: "http://cb",
  });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(base, {
    userId: user.id,
    provider: "gmail",
    code: "c",
    state,
    redirectUri: "http://cb",
  });
  const gmail = createFakeGmail({
    threads: {
      t1: [
        fakeMessage({
          providerMessageId: "m1",
          providerThreadId: "t1",
          subject: "Invoice March",
          snippet: "March invoice",
          from: { name: "Billing", address: "billing@vendor.example" },
        }),
      ],
    },
  });
  const deps: SyncDeps = { ...base, gmail: gmail.factory };
  await syncMailbox(deps, mailAccountId);
  // Older mail outside the backfill: only Gmail search finds it.
  gmail.threads.old = [
    fakeMessage({
      providerMessageId: "o1",
      providerThreadId: "old",
      subject: "Invoice 2024",
      snippet: "Old invoice",
      bodyText: "Total: 120 EUR",
      sentAt: new Date("2024-03-01T00:00:00Z"),
    }),
  ];
  return { deps, gmail, userId: user.id, mailAccountId };
}

describe("searchGmailThreads", () => {
  it("returns metadata for Gmail matches and marks threads that are already synced", async () => {
    const { deps, gmail, userId, mailAccountId } = await connected();
    const [synced] = await db.select().from(threads).where(eq(threads.providerThreadId, "t1"));
    const results = await searchGmailThreads(deps, { userId, mailAccountId, query: " invoice " });
    expect(gmail.calls.listThreadIds.at(-1)).toEqual({ query: "invoice", maxResults: 20 });
    expect(results).toEqual([
      {
        providerThreadId: "t1",
        subject: "Invoice March",
        from: { name: "Billing", address: "billing@vendor.example" },
        date: expect.any(Date),
        snippet: "March invoice",
        localThreadId: synced?.id,
      },
      {
        providerThreadId: "old",
        subject: "Invoice 2024",
        from: expect.any(Object),
        date: new Date("2024-03-01T00:00:00Z"),
        snippet: "Old invoice",
        localThreadId: null,
      },
    ]);
  });

  it("refuses another user's mailbox before calling Gmail", async () => {
    const { deps, gmail, mailAccountId } = await connected();
    const mallory = await insertUser(db);
    const before = gmail.calls.factory;
    await expect(
      searchGmailThreads(deps, { userId: mallory.id, mailAccountId, query: "x" }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
    await expect(
      importThread(deps, { userId: mallory.id, mailAccountId, providerThreadId: "old" }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
    expect(gmail.calls.factory).toBe(before);
  });

  it("asks for reconnection when the mailbox needs it", async () => {
    const { deps, userId, mailAccountId } = await connected();
    await db
      .update(mailAccounts)
      .set({ status: "needs_reauth" })
      .where(eq(mailAccounts.id, mailAccountId));
    await expect(
      searchGmailThreads(deps, { userId, mailAccountId, query: "x" }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
  });
});

describe("importThread", () => {
  it("stores a Gmail thread like sync does and returns its local id, idempotently", async () => {
    const { deps, userId, mailAccountId } = await connected();
    const id = await importThread(deps, { userId, mailAccountId, providerThreadId: "old" });
    expect(id).toEqual(expect.any(String));
    const [row] = await db.select().from(threads).where(eq(threads.providerThreadId, "old"));
    expect(row).toMatchObject({ id, subject: "Invoice 2024" });
    const stored = await db.select().from(messages).where(eq(messages.threadId, id ?? ""));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.bodyCiphertext).not.toBeNull();
    expect(await importThread(deps, { userId, mailAccountId, providerThreadId: "old" })).toBe(id);
  });

  it("returns null when Gmail no longer has the thread", async () => {
    const { deps, userId, mailAccountId } = await connected();
    expect(
      await importThread(deps, { userId, mailAccountId, providerThreadId: "nope" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @replywise/sync test:int`
Expected: FAIL (old backfill query; `./gmail-search` missing).

- [ ] **Step 3: Implement**

`packages/sync/src/sync-mailbox.ts`:
```ts
/** Inbox and Sent of the last 30 days (spec M6 §3); capped at MAX_BACKFILL_THREADS, newest first. */
export const BACKFILL_QUERY = "(in:inbox OR in:sent) newer_than:30d";
```

Append to `packages/db/src/queries/sync.ts` (`and`, `eq`, `inArray` and `threads` are already imported there; add any that are missing):
```ts
/** Local thread ids for provider thread ids of one mailbox. Caller verified mailbox ownership. */
export async function findLocalThreadIds(
  db: DbExecutor,
  mailAccountId: string,
  providerThreadIds: string[],
): Promise<Map<string, string>> {
  if (providerThreadIds.length === 0) return new Map();
  const rows = await db
    .select({ id: threads.id, providerThreadId: threads.providerThreadId })
    .from(threads)
    .where(
      and(
        eq(threads.mailAccountId, mailAccountId),
        inArray(threads.providerThreadId, providerThreadIds),
      ),
    );
  return new Map(rows.map((row) => [row.providerThreadId, row.id]));
}
```

Create `packages/sync/src/gmail-search.ts`:
```ts
import type { EmailAddress } from "@replywise/core";
import { findLocalThreadIds, getMailAccountForUser, type MailAccount } from "@replywise/db";
import { clock, getValidAccessToken, MailAccountNotFoundError } from "@replywise/mailbox";
import { mapWithConcurrency } from "./concurrency";
import type { SyncDeps } from "./deps";
import { persistThreads } from "./persist";

export const GMAIL_QUERY_MAX_CHARS = 200;
export const GMAIL_SEARCH_MAX_RESULTS = 20;
const METADATA_CONCURRENCY = 5;

export interface GmailSearchResult {
  providerThreadId: string;
  subject: string;
  from: EmailAddress;
  date: Date;
  snippet: string;
  /** Set when the thread is already stored in Replywise. */
  localThreadId: string | null;
}

/** The user's own Gmail mailbox; anything else is reported as not found. */
async function ownedGmailMailbox(
  deps: SyncDeps,
  userId: string,
  mailAccountId: string,
): Promise<MailAccount> {
  const account = await getMailAccountForUser(deps.db, userId, mailAccountId);
  if (!account || account.provider !== "gmail") throw new MailAccountNotFoundError(mailAccountId);
  return account;
}

/**
 * "Search all of Gmail" (spec M6 §5.2): Gmail query syntax, 20 threads, metadata only. The query
 * goes straight to Gmail and is never logged or stored.
 */
export async function searchGmailThreads(
  deps: SyncDeps,
  input: { userId: string; mailAccountId: string; query: string },
): Promise<GmailSearchResult[]> {
  const account = await ownedGmailMailbox(deps, input.userId, input.mailAccountId);
  const query = input.query.trim().slice(0, GMAIL_QUERY_MAX_CHARS);
  // Outside any transaction: a token refresh may call the provider.
  const { accessToken } = await getValidAccessToken(deps, account.id);
  const api = deps.gmail(accessToken);
  const { ids } = await api.listThreadIds({ query, maxResults: GMAIL_SEARCH_MAX_RESULTS });
  const metadata = await mapWithConcurrency(ids, METADATA_CONCURRENCY, (id) =>
    api.getThreadMetadata(id),
  );
  const local = await findLocalThreadIds(deps.db, account.id, ids);
  return metadata.flatMap((m) =>
    m ? [{ ...m, localThreadId: local.get(m.providerThreadId) ?? null }] : [],
  );
}

/**
 * Fetches one Gmail thread and stores it through the sync persistence path (spec M6 §5.2). A
 * later re-backfill may prune it when it is outside the backfill window; it can be imported again.
 */
export async function importThread(
  deps: SyncDeps,
  input: { userId: string; mailAccountId: string; providerThreadId: string },
): Promise<string | null> {
  const account = await ownedGmailMailbox(deps, input.userId, input.mailAccountId);
  const { accessToken } = await getValidAccessToken(deps, account.id);
  const thread = await deps.gmail(accessToken).getThread(input.providerThreadId);
  if (!thread) return null;
  const owner = { id: account.id, userId: account.userId, emailAddress: account.emailAddress };
  await deps.db.transaction((tx) =>
    persistThreads(tx, deps.encryptor, owner, [thread], clock(deps)),
  );
  const local = await findLocalThreadIds(deps.db, account.id, [input.providerThreadId]);
  return local.get(input.providerThreadId) ?? null;
}
```
Add `export * from "./gmail-search";` to `packages/sync/src/index.ts`.

Imported threads and classification: the minutely scan only picks INBOX threads whose last message is within 7 days and is not Other. Old imports (the reason to search Gmail) are therefore never classified. A recent inbox thread imported by hand would be classified like any synced one; that case is recorded in the M6 notes (Task 11).

- [ ] **Step 4: Run and see them pass**

Run: `pnpm --filter @replywise/sync test:int && pnpm --filter @replywise/db test:int && pnpm --filter @replywise/mail test && pnpm typecheck`
Expected: PASS. The no-send guard also scans `gmail-search.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/sync packages/db
git commit -m "feat(sync): back-fill Sent, search all of Gmail and import threads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Queue `draft.send` and the worker send job, plus stuck-send recovery

**Files:**
- Modify: `packages/queue/src/jobs.ts`, `packages/queue/src/bullmq.ts`, `packages/queue/src/bullmq.int.test.ts`
- Create: `apps/worker/src/jobs/gmail-draft-write.ts`, `apps/worker/src/jobs/recover-sends.ts`, `apps/worker/src/send.int.test.ts`
- Replace: `apps/worker/src/jobs/send-draft.ts` (the Task 4 stub)
- Modify: `apps/worker/src/jobs/save-draft.ts`, `apps/worker/src/jobs/generation-errors.ts`, `apps/worker/src/main.ts`, `apps/worker/src/main.int.test.ts`

**Interfaces:**
- Consumes: Task 1 send queries and constants; Task 4 `pickReplyTarget`, `GmailSendFactory`, `createGmailSendApi`; M5 `GmailDraftsFactory`, `buildReplyMime`, `toBase64Url`, `getValidAccessToken`, `markThreadAnswered`, `insertAuditLog`, `withWriteRetries`, `isFinalAttempt`, `FIRST_ATTEMPT`, `sanitizeError`, `safeErrorFields`.
- Produces:
  - `@replywise/queue`: `QueueName` gains `"send"`; jobs `"draft.send": { queue: "send", payload: { draftId: uuid } }` and `"maintenance.recoverSends": { queue: "maintenance", payload: {} }`; `sendJobId(draftId: string, sendAt: Date): string` = `` `send_${draftId}_${sendAt.getTime()}` ``; `JobQueue.removeJob(queue: QueueName, jobId: string): Promise<void>`.
  - Worker: `sendDraftHandler(deps: SendDraftDeps)` with `SendDraftDeps = SaveDraftDeps & { queue: JobQueue; gmailSend?: GmailSendFactory }`; `recoverSendsHandler(deps: { db; queue; logger; now?: () => Date })`; `NoRecipientError` (generation-errors); `buildDraftRaw(deps, draft, source): Promise<string>`; `writeGmailDraft(api, existingId: string | null, input: { raw: string; threadId: string }): Promise<string>`; `startWorker(…, { gmailSend? })`; `RECOVER_SENDS_SCHEDULER_ID = "maintenance.recoverSends:minutely"`.

Send job rules (spec §2.2), in order:
1. **Claim** `scheduled → sending` only when `send_at <= now`. If the delayed job fired a little early, wait out the undo window (at most 15 s) and claim once more. A row already `sending` **without** the `send_attempted` marker is resumed (an earlier run stopped before the send call: a rate limit or a crash). Anything else exits without action.
2. **Write the Gmail draft** with the M5 code (`buildDraftRaw` + `writeGmailDraft`), then record its id. A rate limit here is retried (BullMQ attempts); on the final attempt, or for any other failure, the row becomes `send_failed` with the M5 save error code (`gmail_unavailable`, `gmail_reauth`, `no_recipient`, `internal`). Nothing was sent.
3. **Mark the attempt** (`error = send_attempted`, conditional on `error is null`): from here a crashed or duplicate run can never call Gmail again.
4. **Call Gmail's send-draft endpoint once.** Rate-limit answer → clear the marker and retry (final attempt → `gmail_unavailable`). Other 4xx → `send_rejected`. Timeout, network, 5xx or a malformed success → `send_unconfirmed`. Never retried.
5. **Record**: `markSent` (in-process write retries; never a BullMQ retry), `markThreadAnswered`, audit `draft.sent`, enqueue `mailbox.sync` (jobId `sync_after_send_<draftId>`).
6. Every failure writes audit `draft.send_failed` with `{ draftId, threadId, mailAccountId, error }` and throws `UnrecoverableError(<code>)`.

Stuck-send scan: spec §2.2 puts it in "the existing minutely maintenance job". It runs as its own minutely maintenance job (`maintenance.recoverSends`) on the same maintenance worker, so it is independently testable and a slow classification scan never delays it. It also fails `scheduled` rows more than 10 minutes past `send_at` as `internal` (never claimed, so nothing was sent); without that, a row whose job failed before claiming would stay scheduled forever because BullMQ keeps the failed job id and dedupes the re-enqueue.

- [ ] **Step 1: Queue definitions and `removeJob`**

`packages/queue/src/jobs.ts`:
```ts
export type QueueName = "sync" | "ai" | "send" | "maintenance";
```
Add to `jobDefinitions`:
```ts
  "maintenance.recoverSends": { queue: "maintenance", payload: z.object({}).strict() },
  "draft.send": { queue: "send", payload: z.object({ draftId: z.uuid() }).strict() },
```
Add to `interface JobQueue`:
```ts
  /** Removes a waiting or delayed job. A no-op for missing jobs; active (locked) jobs stay. */
  removeJob(queue: QueueName, jobId: string): Promise<void>;
```
And at the end of the file:
```ts
/**
 * Job id of one confirmed send: undo removes it, and the stuck-send scan re-enqueues with the same
 * id so BullMQ dedupes it. BullMQ custom ids cannot contain ":".
 */
export function sendJobId(draftId: string, sendAt: Date): string {
  return `send_${draftId}_${sendAt.getTime()}`;
}
```

`packages/queue/src/bullmq.ts`, in the object returned by `createJobQueue` (after `listRepeating`):
```ts
    async removeJob(queue, jobId) {
      await queueFor(queue).remove(jobId);
    },
```

Append to `packages/queue/src/bullmq.int.test.ts`, inside `describe("BullMQ job queue", …)`:
```ts
  it("removes a delayed job by id and ignores unknown ids", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    const inspector = new Queue("maintenance", { connection: connection(), prefix });
    closers.push(() => inspector.close());
    await queue.enqueue("maintenance.purgeBodies", {}, { jobId: "later", delayMs: 60_000 });
    expect(await inspector.getJob("later")).toBeTruthy();
    await queue.removeJob("maintenance", "later");
    expect(await inspector.getJob("later")).toBeFalsy();
    await expect(queue.removeJob("maintenance", "missing")).resolves.toBeUndefined();
  });
```

Run: `pnpm --filter @replywise/queue test:int && pnpm --filter @replywise/queue typecheck`
Expected: PASS.

- [ ] **Step 2: Write the failing worker tests**

Create `apps/worker/src/send.int.test.ts`:
```ts
import { aad } from "@replywise/crypto";
import {
  auditLogs,
  getDraftForWorker,
  mailAccounts,
  messages,
  replyDrafts,
  SEND_ATTEMPTED,
  scheduleSend,
  threadInsights,
  undoSend,
} from "@replywise/db";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "@replywise/db/testing";
import { type GmailDraftsFactory, type GmailSendFactory, ProviderHttpError } from "@replywise/mail";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { createLogger } from "@replywise/observability";
import { type JobQueue, sendJobId } from "@replywise/queue";
import { UnrecoverableError } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recoverSendsHandler } from "./jobs/recover-sends";
import { sendDraftHandler } from "./jobs/send-draft";

let handle: Awaited<ReturnType<typeof setupTestDb>>;
const encryptor = testEncryptor();
const logger = createLogger({ name: "test", level: "silent" });
const first = { jobId: "t", attempt: 1 };
const second = { jobId: "t", attempt: 2 };
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const BODY = "Hi Ada,\n\nSigned and attached.";
const rateLimited = () => new ProviderHttpError(429, "/gmail/v1/users/me/drafts", true);

beforeAll(async () => {
  handle = await setupTestDb();
});
afterAll(async () => handle.close());
beforeEach(async () => resetTestDb(handle.db));

async function seed(options: { providerDraftId?: string } = {}) {
  const { db } = handle;
  const user = await insertUser(db, { name: "Me" });
  const account = await insertMailAccount(db, user.id, { emailAddress: "me@gmail.com" });
  const tokens = {
    accessToken: "access-stored",
    refreshToken: "refresh-stored",
    expiresAt: new Date(Date.now() + 365 * 24 * HOUR_MS).toISOString(),
  };
  await db
    .update(mailAccounts)
    .set({
      tokensCiphertext: await encryptor.encrypt(JSON.stringify(tokens), aad.mailTokens(account.id)),
    })
    .where(eq(mailAccounts.id, account.id));
  const thread = await insertThread(db, account.id, {
    subject: "Contract",
    providerLabels: ["INBOX"],
  });
  const m1 = await insertMessage(db, thread.id, account.id, {
    fromAddress: { name: "Ada", address: "ada@client.com" },
    internetMessageId: "<m1@client.com>",
    sentAt: new Date(Date.now() - HOUR_MS),
  });
  await db.insert(threadInsights).values({
    threadId: thread.id,
    category: "needs_reply",
    urgency: 3,
    importance: 3,
    needsReply: true,
    reasons: ["Ada asks."],
    classifiedThroughMessageId: m1.id,
    aiProvider: "anthropic",
    model: "claude-opus-5-5",
    promptVersion: "classify-v1",
  });
  const [draft] = await db
    .insert(replyDrafts)
    .values({
      threadId: thread.id,
      userId: user.id,
      tone: "professional",
      bodyCiphertext: Buffer.from("placeholder"),
      status: "edited",
      forMessageId: m1.id,
      providerDraftId: options.providerDraftId ?? null,
      aiProvider: "anthropic",
      model: "claude-opus-5-5",
    })
    .returning();
  if (!draft) throw new Error("draft insert failed");
  await db
    .update(replyDrafts)
    .set({ bodyCiphertext: await encryptor.encrypt(BODY, aad.replyDraft(draft.id)) })
    .where(eq(replyDrafts.id, draft.id));
  // Already past the undo window, so the claim succeeds immediately.
  const sendAt = new Date(Date.now() - 1_000);
  expect(await scheduleSend(db, user.id, draft.id, sendAt, new Date())).toBe(true);
  return { user, account, thread, m1, draftId: draft.id, sendAt };
}

function fakeDrafts(errors: Error[] = []) {
  const calls = { create: 0, update: [] as string[] };
  const factory: GmailDraftsFactory = () => ({
    async createDraft() {
      calls.create += 1;
      const error = errors.shift();
      if (error) throw error;
      return { draftId: "r-1" };
    },
    async updateDraft(id) {
      calls.update.push(id);
      const error = errors.shift();
      if (error) throw error;
      return { draftId: id };
    },
  });
  return { factory, calls };
}

function fakeSender(results: Array<Error | string> = []) {
  const calls: string[] = [];
  const factory: GmailSendFactory = () => ({
    async sendDraft(providerDraftId) {
      calls.push(providerDraftId);
      const next = results.shift() ?? "msg-1";
      if (next instanceof Error) throw next;
      return { messageId: next, threadId: "gmail-thread" };
    },
  });
  return { factory, calls };
}

function fakeQueue() {
  const jobs: Array<{ name: string; payload: unknown; jobId?: string }> = [];
  const queue = {
    async enqueue(name: string, payload: unknown, options?: { jobId?: string }) {
      jobs.push({ name, payload, ...(options?.jobId ? { jobId: options.jobId } : {}) });
    },
  } as unknown as JobQueue;
  return { queue, jobs };
}

function handler(
  drafts: ReturnType<typeof fakeDrafts>,
  sender: ReturnType<typeof fakeSender>,
  queue = fakeQueue().queue,
) {
  const { db } = handle;
  return sendDraftHandler({
    db,
    encryptor,
    logger,
    queue,
    gmailDrafts: drafts.factory,
    gmailSend: sender.factory,
    mailbox: { db, encryptor, providers: { gmail: createFakeProvider("gmail").provider } },
  });
}

async function auditActions() {
  return handle.db.select().from(auditLogs);
}

describe("sendDraftHandler", () => {
  it("writes the Gmail draft, sends it once and records the result", async () => {
    const s = await seed();
    const drafts = fakeDrafts();
    const sender = fakeSender();
    const { queue, jobs } = fakeQueue();
    const run = handler(drafts, sender, queue);
    await run({ draftId: s.draftId }, first);

    expect(drafts.calls.create).toBe(1);
    expect(sender.calls).toEqual(["r-1"]);
    const row = await getDraftForWorker(handle.db, s.draftId);
    expect(row).toMatchObject({
      status: "sent",
      providerDraftId: "r-1",
      providerMessageId: "msg-1",
      error: null,
    });
    expect(row?.sentAt).toBeInstanceOf(Date);
    const [insight] = await handle.db
      .select()
      .from(threadInsights)
      .where(eq(threadInsights.threadId, s.thread.id));
    expect(insight?.needsReply).toBe(false);
    const audit = await auditActions();
    expect(audit.map((a) => a.action)).toEqual(["draft.sent"]);
    expect(audit[0]?.metadata).toEqual({
      draftId: s.draftId,
      threadId: s.thread.id,
      mailAccountId: s.account.id,
    });
    expect(JSON.stringify(audit)).not.toContain("Signed");
    expect(jobs).toEqual([
      {
        name: "mailbox.sync",
        payload: { mailAccountId: s.account.id },
        jobId: `sync_after_send_${s.draftId}`,
      },
    ]);

    await run({ draftId: s.draftId }, second); // a duplicate run is a no-op
    expect(sender.calls).toHaveLength(1);
  });

  it("does nothing when the send was undone before the job ran", async () => {
    const s = await seed();
    await undoSend(handle.db, s.user.id, s.draftId, new Date());
    const drafts = fakeDrafts();
    const sender = fakeSender();
    await handler(drafts, sender)({ draftId: s.draftId }, first);
    expect(drafts.calls.create).toBe(0);
    expect(sender.calls).toEqual([]);
    expect((await getDraftForWorker(handle.db, s.draftId))?.status).toBe("edited");
  });

  it("updates the existing Gmail draft before sending it", async () => {
    const s = await seed({ providerDraftId: "r-0" });
    const drafts = fakeDrafts();
    const sender = fakeSender();
    await handler(drafts, sender)({ draftId: s.draftId }, first);
    expect(drafts.calls).toEqual({ create: 0, update: ["r-0"] });
    expect(sender.calls).toEqual(["r-0"]);
  });

  it("retries a rate limit before the send call and then sends once", async () => {
    const s = await seed();
    const drafts = fakeDrafts([rateLimited()]);
    const sender = fakeSender();
    const run = handler(drafts, sender);
    await expect(run({ draftId: s.draftId }, first)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sending",
      error: null,
    });
    expect(sender.calls).toEqual([]);
    await run({ draftId: s.draftId }, second);
    expect(sender.calls).toEqual(["r-1"]);
    expect((await getDraftForWorker(handle.db, s.draftId))?.status).toBe("sent");
  });

  it("retries a rate-limited send call, which Gmail did not process", async () => {
    const s = await seed();
    const sender = fakeSender([rateLimited(), "msg-2"]);
    const run = handler(fakeDrafts(), sender);
    await expect(run({ draftId: s.draftId }, first)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sending",
      error: null,
    });
    await run({ draftId: s.draftId }, second);
    expect(sender.calls).toEqual(["r-1", "r-1"]);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sent",
      providerMessageId: "msg-2",
    });
  });

  it("never retries an ambiguous send failure", async () => {
    const s = await seed();
    const sender = fakeSender([new ProviderHttpError(503, "/x")]);
    const run = handler(fakeDrafts(), sender);
    await expect(run({ draftId: s.draftId }, first)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "send_failed",
      error: "send_unconfirmed",
    });
    const audit = await auditActions();
    expect(audit.map((a) => [a.action, a.metadata.error])).toEqual([
      ["draft.send_failed", "send_unconfirmed"],
    ]);
    await run({ draftId: s.draftId }, second);
    expect(sender.calls).toHaveLength(1);
  });

  it("maps a timeout to send_unconfirmed and a 4xx to send_rejected", async () => {
    const timedOut = await seed();
    await expect(
      handler(fakeDrafts(), fakeSender([new ProviderHttpError(0, "/x")]))(
        { draftId: timedOut.draftId },
        first,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getDraftForWorker(handle.db, timedOut.draftId))?.error).toBe("send_unconfirmed");

    await resetTestDb(handle.db);
    const rejected = await seed();
    await expect(
      handler(fakeDrafts(), fakeSender([new ProviderHttpError(400, "/x")]))(
        { draftId: rejected.draftId },
        first,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getDraftForWorker(handle.db, rejected.draftId))?.error).toBe("send_rejected");
  });

  it("fails without sending when the Gmail draft cannot be written", async () => {
    const s = await seed();
    const sender = fakeSender();
    await expect(
      handler(fakeDrafts([new ProviderHttpError(500, "/x")]), sender)(
        { draftId: s.draftId },
        first,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "send_failed",
      error: "gmail_unavailable",
    });
    expect(sender.calls).toEqual([]);
  });

  it("never repeats a send call that may already have happened", async () => {
    const s = await seed();
    await handle.db
      .update(replyDrafts)
      .set({ status: "sending", error: SEND_ATTEMPTED })
      .where(eq(replyDrafts.id, s.draftId));
    const drafts = fakeDrafts();
    const sender = fakeSender();
    await handler(drafts, sender)({ draftId: s.draftId }, second);
    expect(drafts.calls.create).toBe(0);
    expect(sender.calls).toEqual([]);
    expect((await getDraftForWorker(handle.db, s.draftId))?.status).toBe("sending");
  });

  it("fails with no_recipient when nobody else wrote in the thread", async () => {
    const s = await seed();
    await handle.db
      .update(replyDrafts)
      .set({ forMessageId: null })
      .where(eq(replyDrafts.id, s.draftId));
    await handle.db.update(messages).set({ isFromUser: true }).where(eq(messages.id, s.m1.id));
    const sender = fakeSender();
    await expect(
      handler(fakeDrafts(), sender)({ draftId: s.draftId }, first),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getDraftForWorker(handle.db, s.draftId))?.error).toBe("no_recipient");
    expect(sender.calls).toEqual([]);
  });
});

describe("recoverSendsHandler", () => {
  it("re-enqueues lost scheduled sends with their job id and fails stuck ones", async () => {
    const s = await seed();
    const now = new Date();
    const lostAt = new Date(now.getTime() - 2 * MIN_MS);
    await handle.db.update(replyDrafts).set({ sendAt: lostAt }).where(eq(replyDrafts.id, s.draftId));
    const [stuck] = await handle.db
      .insert(replyDrafts)
      .values({
        threadId: s.thread.id,
        userId: s.user.id,
        tone: "professional",
        bodyCiphertext: Buffer.from("x"),
        status: "sending",
        aiProvider: "anthropic",
        model: "claude-opus-5-5",
        updatedAt: new Date(now.getTime() - 11 * MIN_MS),
      })
      .returning();
    const { queue, jobs } = fakeQueue();
    await recoverSendsHandler({ db: handle.db, queue, logger, now: () => now })();
    expect(jobs).toEqual([
      { name: "draft.send", payload: { draftId: s.draftId }, jobId: sendJobId(s.draftId, lostAt) },
    ]);
    expect(await getDraftForWorker(handle.db, stuck?.id ?? "")).toMatchObject({
      status: "send_failed",
      error: "send_unconfirmed",
    });
    expect((await auditActions()).map((a) => [a.action, a.metadata.error])).toEqual([
      ["draft.send_failed", "send_unconfirmed"],
    ]);
  });
});
```

- [ ] **Step 3: Run and see them fail**

Run: `pnpm --filter @replywise/worker test:int`
Expected: FAIL (`sendDraftHandler`, `recoverSendsHandler` missing).

- [ ] **Step 4: Implement**

`apps/worker/src/jobs/generation-errors.ts`: add the class and one mapping line (before the `InvalidRecipientError` line):
```ts
/** The thread has no message from someone else to answer. */
export class NoRecipientError extends Error {
  constructor() {
    super("no_recipient");
    this.name = "NoRecipientError";
  }
}
```
```ts
  if (error instanceof NoRecipientError) return "no_recipient";
```

Create `apps/worker/src/jobs/gmail-draft-write.ts` (shared by the save and send jobs):
```ts
import { pickReplyTarget } from "@replywise/core";
import { aad } from "@replywise/crypto";
import { type ClassificationSource, type DraftRow, getWritingPreferences } from "@replywise/db";
import { buildReplyMime, type GmailDraftsApi, toBase64Url } from "@replywise/mail";
import { NoRecipientError } from "./generation-errors";
import type { GenerationDeps } from "./generation-shared";

/**
 * The raw (base64url MIME) reply for a draft: its body plus the user's signature, addressed to
 * and threaded on the message it answers. Throws NoRecipientError or InvalidRecipientError.
 */
export async function buildDraftRaw(
  deps: Pick<GenerationDeps, "db" | "encryptor">,
  draft: DraftRow,
  source: ClassificationSource,
): Promise<string> {
  const target = pickReplyTarget(source.messages, draft.forMessageId);
  if (!target) throw new NoRecipientError();
  const body = await deps.encryptor.decryptString(draft.bodyCiphertext, aad.replyDraft(draft.id));
  const { signature } = await getWritingPreferences(deps.db, source.userId);
  return toBase64Url(
    buildReplyMime({
      from: { name: null, address: source.mailboxEmail },
      to: target.fromAddress,
      subject: source.thread.subject,
      inReplyTo: target.internetMessageId,
      references: source.messages
        .map((m) => m.internetMessageId)
        .filter((id): id is string => Boolean(id)),
      body: signature ? `${body}\n\n${signature}` : body,
    }),
  );
}

/** Updates the existing Gmail draft, or creates one when there is none or Gmail lost it. */
export async function writeGmailDraft(
  api: GmailDraftsApi,
  existingId: string | null,
  input: { raw: string; threadId: string },
): Promise<string> {
  if (existingId) {
    const updated = await api.updateDraft(existingId, input);
    if (updated) return updated.draftId;
  }
  return (await api.createDraft(input)).draftId;
}
```

`apps/worker/src/jobs/save-draft.ts` (behaviour unchanged, the M5 tests must stay green):
- Replace the block from `const target = replyTarget(draft, source);` through the end of the `raw` try/catch with:
```ts
  let raw: string;
  try {
    raw = await buildDraftRaw(deps, draft, source);
  } catch (error) {
    if (error instanceof NoRecipientError) return failDraftSave(deps.db, draftId, "no_recipient");
    if (errorCode(error) === "no_recipient") return giveUp(error);
    throw error;
  }
```
- Delete the local `replyTarget` function.
- Imports: add `import { buildDraftRaw } from "./gmail-draft-write";` and `NoRecipientError` to the `./generation-errors` import; remove the now-unused `aad`, `ClassificationSource`, `getWritingPreferences`, `buildReplyMime` and `toBase64Url` imports (Biome reports leftovers).

Replace `apps/worker/src/jobs/send-draft.ts` entirely:
```ts
import {
  type AuditAction,
  claimSend,
  clearSendAttempted,
  failSend,
  getDraftForWorker,
  getThreadForClassification,
  insertAuditLog,
  markSendAttempted,
  markSent,
  markThreadAnswered,
  recordSendDraftId,
  SEND_ATTEMPTED,
  SEND_DELAY_MS,
} from "@replywise/db";
import { type GmailSendFactory, ProviderHttpError } from "@replywise/mail";
import { createGmailSendApi } from "@replywise/mail/gmail-send";
import { getValidAccessToken } from "@replywise/mailbox";
import type { JobContext, JobQueue } from "@replywise/queue";
import { UnrecoverableError } from "bullmq";
import { safeErrorFields, sanitizeError } from "../log-error";
import { errorCode } from "./generation-errors";
import { FIRST_ATTEMPT, isFinalAttempt, withWriteRetries } from "./generation-shared";
import { buildDraftRaw, writeGmailDraft } from "./gmail-draft-write";
import type { SaveDraftDeps } from "./save-draft";

export type SendDraftDeps = SaveDraftDeps & {
  queue: JobQueue;
  /** Tests inject a fake. Production builds the one real send client here and nowhere else. */
  gmailSend?: GmailSendFactory;
};

/** A delayed job can fire a little early: wait at most this long for the undo window to end. */
const MAX_EARLY_MS = SEND_DELAY_MS + 5_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delivers one reply the user confirmed (spec M6 §2.2): claim → write the Gmail draft (M5 code) →
 * mark the attempt → Gmail's send-draft call → record. Only rate limits are retried. Once the send
 * call may have reached Gmail, nothing repeats it.
 */
export function sendDraftHandler(deps: SendDraftDeps) {
  const senderFor: GmailSendFactory =
    deps.gmailSend ?? ((accessToken) => createGmailSendApi(accessToken));
  return async (
    { draftId }: { draftId: string },
    context: JobContext = FIRST_ATTEMPT,
  ): Promise<void> => {
    try {
      if (!(await claim(deps, draftId))) return;
      await deliver(deps, senderFor, draftId, context);
    } catch (error) {
      // UnrecoverableError ends the job; rate limits are retried by BullMQ. Any other error
      // happened before the send call (deliver turns every later failure into an
      // UnrecoverableError), so a sanitized retry is safe and resumes the claimed row.
      if (error instanceof UnrecoverableError || error instanceof ProviderHttpError) throw error;
      throw sanitizeError(error);
    }
  };
}

/** True when this run owns the send: it claimed the row, or resumes a claim that never sent. */
async function claim(deps: SendDraftDeps, draftId: string): Promise<boolean> {
  if (await claimSend(deps.db, draftId, new Date())) return true;
  const draft = await getDraftForWorker(deps.db, draftId);
  if (draft?.status === "scheduled" && draft.sendAt) {
    const wait = draft.sendAt.getTime() - Date.now();
    if (wait > 0 && wait <= MAX_EARLY_MS) {
      await sleep(wait);
      return claimSend(deps.db, draftId, new Date());
    }
    return false;
  }
  // `sending` without the marker: an earlier run stopped before the send call. With the marker
  // the send may have happened, so it is never resumed (the stuck scan fails it as unconfirmed).
  return draft?.status === "sending" && draft.error !== SEND_ATTEMPTED;
}

async function deliver(
  deps: SendDraftDeps,
  senderFor: GmailSendFactory,
  draftId: string,
  context: JobContext,
): Promise<void> {
  const draft = await getDraftForWorker(deps.db, draftId);
  if (draft?.status !== "sending") return;
  const source = await getThreadForClassification(deps.db, draft.threadId);
  if (!source) return; // the thread is gone, and its drafts with it
  const meta = { draftId, threadId: source.thread.id, mailAccountId: source.thread.mailAccountId };

  /** Ends the send with a fixed code. Never retried. */
  const stop = async (code: string, error?: unknown): Promise<never> => {
    await failSend(deps.db, draftId, code).catch(() => undefined);
    await audit(deps, source.userId, "draft.send_failed", { ...meta, error: code });
    deps.logger.warn(
      { ...meta, code, ...(error === undefined ? {} : { error: safeErrorFields(error) }) },
      "draft send failed",
    );
    throw new UnrecoverableError(code);
  };

  // Gmail only: never another provider's API.
  if (source.provider !== "gmail") return stop("internal");

  // 1. The Gmail draft must hold exactly this body. Nothing has been sent yet: a rate limit is
  //    retried, any other failure ends the send with the M5 save error code.
  let accessToken: string;
  let providerDraftId: string;
  try {
    const raw = await buildDraftRaw(deps, draft, source);
    // Outside any transaction: a token refresh may call the provider.
    ({ accessToken } = await getValidAccessToken(deps.mailbox, source.thread.mailAccountId));
    const written = await writeGmailDraft(deps.gmailDrafts(accessToken), draft.providerDraftId, {
      raw,
      threadId: source.thread.providerThreadId,
    });
    providerDraftId = written;
    if (written !== draft.providerDraftId) {
      await withWriteRetries(() => recordSendDraftId(deps.db, draftId, written));
    }
  } catch (error) {
    if (error instanceof ProviderHttpError && error.rateLimited) {
      if (isFinalAttempt(context)) return stop("gmail_unavailable", error);
      throw error;
    }
    return stop(errorCode(error), error);
  }

  // 2. Mark first, so no later or concurrent run can ever repeat the send call.
  if (!(await markSendAttempted(deps.db, draftId))) {
    deps.logger.info({ draftId }, "draft send already attempted");
    return;
  }
  let messageId: string;
  try {
    const sender = senderFor(accessToken);
    ({ messageId } = await sender.sendDraft(providerDraftId));
  } catch (error) {
    if (error instanceof ProviderHttpError && error.rateLimited) {
      // Gmail did not process the request, so it may be repeated.
      try {
        await clearSendAttempted(deps.db, draftId);
      } catch {
        throw new UnrecoverableError("SendMarkerNotCleared");
      }
      if (isFinalAttempt(context)) return stop("gmail_unavailable", error);
      throw error;
    }
    const rejected =
      error instanceof ProviderHttpError && error.status >= 400 && error.status < 500;
    return stop(rejected ? "send_rejected" : "send_unconfirmed", error);
  }

  // 3. Gmail accepted it. Record in-process: a BullMQ retry would send again.
  try {
    await withWriteRetries(() => markSent(deps.db, draftId, messageId, new Date()));
  } catch (error) {
    deps.logger.warn({ ...meta, error: safeErrorFields(error) }, "draft send not recorded");
    throw new UnrecoverableError("SendRecordFailed");
  }
  await markThreadAnswered(deps.db, source.thread.id).catch((error: unknown) => {
    deps.logger.warn({ ...meta, error: safeErrorFields(error) }, "thread not marked answered");
  });
  await audit(deps, source.userId, "draft.sent", meta);
  await deps.queue
    .enqueue(
      "mailbox.sync",
      { mailAccountId: source.thread.mailAccountId },
      { jobId: `sync_after_send_${draftId}` },
    )
    .catch((error: unknown) => {
      deps.logger.warn({ ...meta, error: safeErrorFields(error) }, "sync after send not queued");
    });
  deps.logger.info({ threadId: source.thread.id, draftId }, "draft sent");
}

async function audit(
  deps: Pick<SendDraftDeps, "db" | "logger">,
  userId: string,
  action: AuditAction,
  metadata: { draftId: string; threadId: string; mailAccountId: string; error?: string },
): Promise<void> {
  await insertAuditLog(deps.db, {
    userId,
    action,
    targetType: "reply_draft",
    targetId: metadata.draftId,
    metadata,
  }).catch((error: unknown) => {
    deps.logger.warn(
      { draftId: metadata.draftId, error: safeErrorFields(error) },
      "audit entry not written",
    );
  });
}
```
Words to keep out of this file (the guard scans it): a slash directly followed by `send`, `drafts.send`, `mail.send`. The client variable is `sender`, the factory `senderFor`.

Create `apps/worker/src/jobs/recover-sends.ts`:
```ts
import {
  type Db,
  expireScheduledSends,
  failStuckSends,
  insertAuditLog,
  listOverdueScheduledSends,
} from "@replywise/db";
import type { Logger } from "@replywise/observability";
import { type JobQueue, sendJobId } from "@replywise/queue";
import { safeErrorFields } from "../log-error";

/**
 * Minutely (spec M6 §2.2 step 5): re-enqueue scheduled sends whose delayed job was lost (same job
 * id; the claim keeps the send single), and fail sends that will never finish. Never re-sends.
 */
export function recoverSendsHandler(deps: {
  db: Db;
  queue: JobQueue;
  logger: Logger;
  now?: () => Date;
}) {
  return async (_payload?: unknown, _context?: unknown): Promise<void> => {
    const now = deps.now?.() ?? new Date();
    const overdue = await listOverdueScheduledSends(deps.db, now);
    for (const { draftId, sendAt } of overdue) {
      await deps.queue.enqueue("draft.send", { draftId }, { jobId: sendJobId(draftId, sendAt) });
    }
    const failed = [
      ...(await expireScheduledSends(deps.db, now)),
      ...(await failStuckSends(deps.db, now)),
    ];
    for (const row of failed) {
      await insertAuditLog(deps.db, {
        userId: row.userId,
        action: "draft.send_failed",
        targetType: "reply_draft",
        targetId: row.draftId,
        metadata: {
          draftId: row.draftId,
          threadId: row.threadId,
          mailAccountId: row.mailAccountId,
          error: row.error,
        },
      }).catch((error: unknown) => {
        deps.logger.warn(
          { draftId: row.draftId, error: safeErrorFields(error) },
          "audit entry not written",
        );
      });
    }
    if (overdue.length > 0 || failed.length > 0) {
      deps.logger.info({ requeued: overdue.length, failed: failed.length }, "send recovery");
    }
  };
}
```

`apps/worker/src/main.ts`:
- Imports: `import type { GmailApiFactory, GmailDraftsFactory, GmailSendFactory } from "@replywise/mail";`, `import { recoverSendsHandler } from "./jobs/recover-sends";`, `import { sendDraftHandler } from "./jobs/send-draft";`.
- Constants: `export const RECOVER_SENDS_SCHEDULER_ID = "maintenance.recoverSends:minutely";` and `const SEND_CONCURRENCY = 2;`.
- `startWorker` options gain `gmailSend?: GmailSendFactory;`.
- After `aiConnection`: `const sendConnection = createRedisConnection(env.REDIS_URL);`.
- Maintenance handlers gain `"maintenance.recoverSends": recoverSendsHandler({ db, queue, logger }),`.
- After `aiWorker`:
```ts
  // Sends get their own queue so slow AI jobs never delay a confirmed send.
  const sendWorker = createJobWorker(
    "send",
    sendConnection,
    {
      "draft.send": sendDraftHandler({
        ...generationDeps,
        queue,
        ...(options.gmailSend ? { gmailSend: options.gmailSend } : {}),
      }),
    },
    { concurrency: SEND_CONCURRENCY, ...prefix },
  );
```
- Add `sendWorker` to the `failed` listener loop, schedule the recovery job:
```ts
  await queue.scheduleRepeating(
    RECOVER_SENDS_SCHEDULER_ID,
    "maintenance.recoverSends",
    {},
    ONE_MINUTE_MS,
  );
```
- In `stop()`: close `sendWorker` with the others and `sendConnection.quit()` with the other connections.

`apps/worker/src/main.int.test.ts`: import `RECOVER_SENDS_SCHEDULER_ID` and add `expect(ids).toContain(RECOVER_SENDS_SCHEDULER_ID);` next to the other scheduler assertions.

- [ ] **Step 5: Run and see them pass**

Run: `pnpm --filter @replywise/queue test:int && pnpm --filter @replywise/worker test && pnpm --filter @replywise/worker test:int && pnpm --filter @replywise/mail test && pnpm typecheck && pnpm format && pnpm lint`
Expected: PASS. Worker int gains 11 tests; every M5 save-draft test stays green; the no-send guard passes with `send-draft.ts` as the single importer.

- [ ] **Step 6: Commit**

```bash
git add packages/queue apps/worker
git commit -m "feat(worker): confirmed send job with undo window, rate-limit-only retries and stuck-send recovery" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web: confirm, undo and send states in the reply composer

**Files:**
- Create: `apps/web/src/app/(app)/thread/[id]/send-actions.ts`, `apps/web/src/app/(app)/thread/[id]/send-actions.test.ts`
- Create: `apps/web/src/components/thread/send-controls.tsx`, `apps/web/src/components/thread/send-controls.test.tsx`, `apps/web/src/components/thread/send-countdown.tsx`
- Modify: `apps/web/src/components/thread/reply-composer.tsx`, `apps/web/src/components/thread/thread-view.tsx`, `apps/web/src/app/(app)/thread/[id]/page.tsx`
- Modify: `apps/web/src/app/(app)/thread/[id]/actions.ts` (+ `actions.test.ts`): no regenerate while a send runs
- Modify: `apps/web/src/lib/draft-messages.ts` (+ `draft-messages.test.ts`)

**Interfaces:**
- Consumes: Task 1 `scheduleSend`, `undoSend`, `reopenFailedSend`, `countRecentSends`, `getDraftMailbox`, `hasActiveSend`, `SEND_DELAY_MS`, `SEND_RATE_LIMIT`, `RESENDABLE_FAILURES`; Task 4 `pickReplyTarget`, `replySubject`; Task 6 `sendJobId`, `JobQueue.removeJob`; M5 `getDraftForUser`, `insertAuditLog`, `aad.replyDraft`.
- Produces:
  - Server Actions `scheduleSendAction(input: { draftId: string; expectedBody: string }): Promise<SendActionResult>`, `undoSendAction(input: { draftId: string }): Promise<SendActionResult>`, `editFailedSendAction(formData: FormData{draftId, threadId}): Promise<void>`.
  - `SendActionResult = { ok: true } | { ok: false; error: SendActionErrorCode }`, `SendActionErrorCode = "not_sendable" | "draft_changed" | "send_rate_limited" | "too_late" | "internal"` (in `lib/draft-messages.ts`).
  - `sendFailure(code: string | null): string`, `sendActionError(code: SendActionErrorCode): string`.
  - `DraftView` gains `sendAt`, `sentAt`, `sendPreview: { to: string; subject: string } | null`, `canResend: boolean`; its `status` covers the four send states. `ReplyComposer` gains `gmailThreadHref: string | null`.

UI rules (spec §2.4): `scheduled` → countdown + Undo; `sending` → "Sending…"; `sent` → "Sent ✓" with "Open in Gmail", composer locked; `send_failed` → error text per code with "Edit" and, when nothing was sent (`canResend`), "Try again" (a new confirm). The spec names "Try again" for `send_rejected`; the §2.1 state machine also allows a new confirm after an M5 save error, so the button follows `RESENDABLE_FAILURES`. "Send…" appears only for Gmail mailboxes with a reply target. The dialog refuses to confirm while the textarea holds unsaved edits ("Save edits first"), so the confirmed `expectedBody` is always the stored body.

- [ ] **Step 1: Messages (with tests)**

Append to `apps/web/src/lib/draft-messages.ts`:
```ts
/** Copy for send_failed codes written by the worker (spec M6 §2.4). */
export function sendFailure(code: string | null): string {
  if (code === "send_unconfirmed") {
    return "The send may or may not have gone out — check your Gmail Sent folder.";
  }
  if (code === "send_rejected") return "Gmail refused to send this reply. Nothing was sent.";
  return `${generationError(code ?? "internal") ?? GENERATION_ERRORS.internal} Nothing was sent.`;
}

export type SendActionErrorCode =
  | "not_sendable"
  | "draft_changed"
  | "send_rate_limited"
  | "too_late"
  | "internal";

export const SEND_ACTION_ERRORS: Record<SendActionErrorCode, string> = {
  not_sendable: "This reply can't be sent right now. Reload the page and try again.",
  draft_changed: "The draft changed after you opened this dialog. Review it and confirm again.",
  send_rate_limited: "You've sent 20 replies in the last hour. Try again later.",
  too_late: "Too late to undo: the reply is already being sent.",
  internal: "Something went wrong. Nothing was sent. Try again.",
};

export function sendActionError(code: SendActionErrorCode): string {
  return SEND_ACTION_ERRORS[code];
}
```
Append to `apps/web/src/lib/draft-messages.test.ts` (extend the import with `sendFailure`):
```ts
describe("sendFailure", () => {
  it("explains unconfirmed and rejected sends, and says nothing was sent for save errors", () => {
    expect(sendFailure("send_unconfirmed")).toMatch(/may or may not have gone out/);
    expect(sendFailure("send_rejected")).toMatch(/Nothing was sent/);
    expect(sendFailure("gmail_reauth")).toBe(
      "Gmail needs to be reconnected (Settings → Mailboxes). Nothing was sent.",
    );
    expect(sendFailure(null)).toBe("Something went wrong. Try again. Nothing was sent.");
  });
});
```

- [ ] **Step 2: Write the failing Server Action tests**

Create `apps/web/src/app/(app)/thread/[id]/send-actions.test.ts`:
```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const BOX_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-25T12:00:00Z");
const STORED = "Hi Ada,\n\nYes.";

const { enqueue, removeJob, encryptor, dbMocks } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  removeJob: vi.fn(),
  encryptor: { decryptString: vi.fn() },
  dbMocks: {
    countRecentSends: vi.fn(),
    getDraftForUser: vi.fn(),
    getDraftMailbox: vi.fn(),
    insertAuditLog: vi.fn(),
    reopenFailedSend: vi.fn(),
    scheduleSend: vi.fn(),
    undoSend: vi.fn(),
    SEND_DELAY_MS: 10_000,
    SEND_RATE_LIMIT: 20,
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/queue", () => ({ getQueue: () => ({ enqueue, removeJob }) }));
vi.mock("@/lib/crypto", () => ({ getEncryptor: () => encryptor }));
vi.mock("@/lib/mailbox", () => ({ requestContext: () => ({ ip: null, userAgent: null }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@replywise/db", () => dbMocks);
vi.mock("@replywise/queue", () => ({
  sendJobId: (draftId: string, sendAt: Date) => `send_${draftId}_${sendAt.getTime()}`,
}));

import { editFailedSendAction, scheduleSendAction, undoSendAction } from "./send-actions";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  enqueue.mockResolvedValue(undefined);
  removeJob.mockResolvedValue(undefined);
  encryptor.decryptString.mockResolvedValue(STORED);
  dbMocks.getDraftForUser.mockResolvedValue({
    id: DRAFT_ID,
    threadId: THREAD_ID,
    status: "edited",
    bodyCiphertext: Buffer.from("ct"),
  });
  dbMocks.getDraftMailbox.mockResolvedValue({
    threadId: THREAD_ID,
    mailAccountId: BOX_ID,
    provider: "gmail",
  });
  dbMocks.countRecentSends.mockResolvedValue(0);
  dbMocks.scheduleSend.mockResolvedValue(true);
  dbMocks.undoSend.mockResolvedValue({ sendAt: new Date(NOW.getTime() + 10_000) });
  dbMocks.insertAuditLog.mockResolvedValue(undefined);
  dbMocks.reopenFailedSend.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleSendAction", () => {
  it("schedules exactly what was confirmed and enqueues one delayed job", async () => {
    await expect(
      scheduleSendAction({ draftId: DRAFT_ID, expectedBody: "Hi Ada,\r\n\r\nYes." }),
    ).resolves.toEqual({ ok: true });
    const sendAt = new Date(NOW.getTime() + 10_000);
    expect(dbMocks.scheduleSend).toHaveBeenCalledWith({}, "user-1", DRAFT_ID, sendAt, NOW);
    expect(enqueue).toHaveBeenCalledWith(
      "draft.send",
      { draftId: DRAFT_ID },
      { jobId: `send_${DRAFT_ID}_${sendAt.getTime()}`, delayMs: 10_000 },
    );
    expect(dbMocks.insertAuditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        userId: "user-1",
        action: "draft.send_scheduled",
        metadata: { draftId: DRAFT_ID, threadId: THREAD_ID, mailAccountId: BOX_ID },
      }),
    );
    expect(JSON.stringify(dbMocks.insertAuditLog.mock.calls)).not.toContain("Ada");
  });

  it("refuses when the stored body differs from the confirmed one", async () => {
    await expect(
      scheduleSendAction({ draftId: DRAFT_ID, expectedBody: "Hi Ada,\n\nNo." }),
    ).resolves.toEqual({ ok: false, error: "draft_changed" });
    expect(dbMocks.scheduleSend).not.toHaveBeenCalled();
  });

  it("refuses non-Gmail mailboxes, foreign drafts and bad ids", async () => {
    dbMocks.getDraftMailbox.mockResolvedValueOnce({
      threadId: THREAD_ID,
      mailAccountId: BOX_ID,
      provider: "outlook",
    });
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    dbMocks.getDraftForUser.mockResolvedValueOnce(null);
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    await expect(scheduleSendAction({ draftId: "nope", expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    expect(dbMocks.scheduleSend).not.toHaveBeenCalled();
  });

  it("refuses at 20 sends in the last hour", async () => {
    dbMocks.countRecentSends.mockResolvedValue(20);
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "send_rate_limited",
    });
    expect(dbMocks.scheduleSend).not.toHaveBeenCalled();
  });

  it("enqueues nothing when the draft cannot be scheduled", async () => {
    dbMocks.scheduleSend.mockResolvedValue(false);
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("hands control back when the job cannot be enqueued", async () => {
    enqueue.mockRejectedValue(new Error("redis down"));
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "internal",
    });
    expect(dbMocks.undoSend).toHaveBeenCalledWith({}, "user-1", DRAFT_ID, NOW);
  });
});

describe("undoSendAction", () => {
  it("returns the draft to editing, removes the delayed job and audits", async () => {
    await expect(undoSendAction({ draftId: DRAFT_ID })).resolves.toEqual({ ok: true });
    expect(removeJob).toHaveBeenCalledWith("send", `send_${DRAFT_ID}_${NOW.getTime() + 10_000}`);
    expect(dbMocks.insertAuditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: "draft.send_undone" }),
    );
  });

  it("reports too_late once the worker claimed the send", async () => {
    dbMocks.undoSend.mockResolvedValue(null);
    await expect(undoSendAction({ draftId: DRAFT_ID })).resolves.toEqual({
      ok: false,
      error: "too_late",
    });
    expect(removeJob).not.toHaveBeenCalled();
  });
});

describe("editFailedSendAction", () => {
  it("reopens a failed send for editing", async () => {
    const data = new FormData();
    data.set("draftId", DRAFT_ID);
    data.set("threadId", THREAD_ID);
    await editFailedSendAction(data);
    expect(dbMocks.reopenFailedSend).toHaveBeenCalledWith({}, "user-1", DRAFT_ID, NOW);
  });
});
```

In `apps/web/src/app/(app)/thread/[id]/actions.test.ts`: add `hasActiveSend: vi.fn(),` to `dbMocks`, `dbMocks.hasActiveSend.mockResolvedValue(false);` to `beforeEach`, and inside `describe("generateDraftAction", …)`:
```ts
  it("does not regenerate while a send of this thread is scheduled or sending", async () => {
    dbMocks.hasActiveSend.mockResolvedValue(true);
    await generateDraftAction(form({ threadId: THREAD_ID }));
    expect(dbMocks.createPendingDraft).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run and see them fail**

Run: `pnpm --filter @replywise/web test`
Expected: FAIL (`./send-actions` missing; `hasActiveSend` not used yet; `sendFailure` missing).

- [ ] **Step 4: Implement the Server Actions**

Create `apps/web/src/app/(app)/thread/[id]/send-actions.ts`:
```ts
"use server";

import { aad } from "@replywise/crypto";
import {
  countRecentSends,
  getDraftForUser,
  getDraftMailbox,
  insertAuditLog,
  reopenFailedSend,
  SEND_DELAY_MS,
  SEND_RATE_LIMIT,
  scheduleSend,
  undoSend,
} from "@replywise/db";
import { sendJobId } from "@replywise/queue";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { getEncryptor } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import type { SendActionErrorCode } from "@/lib/draft-messages";
import { requestContext } from "@/lib/mailbox";
import { getQueue } from "@/lib/queue";

export type SendActionResult = { ok: true } | { ok: false; error: SendActionErrorCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 20_000;
const fail = (error: SendActionErrorCode): SendActionResult => ({ ok: false, error });

function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").slice(0, MAX_BODY);
}

async function audit(
  userId: string,
  action: "draft.send_scheduled" | "draft.send_undone",
  metadata: { draftId: string; threadId: string; mailAccountId: string },
): Promise<void> {
  const context = requestContext(await headers());
  // Best effort: never block or fail the user's action over the audit row.
  await insertAuditLog(getDb(), {
    userId,
    action,
    targetType: "reply_draft",
    targetId: metadata.draftId,
    metadata,
    ip: context.ip,
    userAgent: context.userAgent,
  }).catch(() => undefined);
}

/**
 * The only way a send starts (spec M6 §2.2): after the confirmation dialog. What was confirmed
 * (`expectedBody`) must equal the stored body, so exactly that text is sent after 10 seconds.
 */
export async function scheduleSendAction(input: {
  draftId: string;
  expectedBody: string;
}): Promise<SendActionResult> {
  const user = await requireUser();
  const draftId = typeof input?.draftId === "string" ? input.draftId : "";
  if (!UUID.test(draftId) || typeof input.expectedBody !== "string") return fail("not_sendable");
  const db = getDb();
  const [draft, mailbox] = await Promise.all([
    getDraftForUser(db, user.id, draftId),
    getDraftMailbox(db, user.id, draftId),
  ]);
  if (!draft || !mailbox || mailbox.provider !== "gmail") return fail("not_sendable");
  let stored: string;
  try {
    stored = await getEncryptor().decryptString(draft.bodyCiphertext, aad.replyDraft(draft.id));
  } catch {
    return fail("not_sendable");
  }
  if (stored !== normalizeBody(input.expectedBody)) return fail("draft_changed");
  const now = new Date();
  if ((await countRecentSends(db, user.id, now)) >= SEND_RATE_LIMIT) {
    return fail("send_rate_limited");
  }
  const sendAt = new Date(now.getTime() + SEND_DELAY_MS);
  if (!(await scheduleSend(db, user.id, draftId, sendAt, now))) return fail("not_sendable");
  try {
    await getQueue().enqueue(
      "draft.send",
      { draftId },
      { jobId: sendJobId(draftId, sendAt), delayMs: SEND_DELAY_MS },
    );
  } catch {
    // Without a job only the stuck-send scan would start it; give the draft back instead.
    await undoSend(db, user.id, draftId, now);
    return fail("internal");
  }
  await audit(user.id, "draft.send_scheduled", {
    draftId,
    threadId: mailbox.threadId,
    mailAccountId: mailbox.mailAccountId,
  });
  revalidatePath(`/thread/${mailbox.threadId}`);
  return { ok: true };
}

/** scheduled → edited, only inside the undo window (before the worker claims it). */
export async function undoSendAction(input: { draftId: string }): Promise<SendActionResult> {
  const user = await requireUser();
  const draftId = typeof input?.draftId === "string" ? input.draftId : "";
  if (!UUID.test(draftId)) return fail("not_sendable");
  const db = getDb();
  const mailbox = await getDraftMailbox(db, user.id, draftId);
  if (!mailbox) return fail("not_sendable");
  const undone = await undoSend(db, user.id, draftId, new Date());
  if (!undone) return fail("too_late");
  if (undone.sendAt) {
    // Best effort: the claim already makes a leftover job a no-op.
    await getQueue()
      .removeJob("send", sendJobId(draftId, undone.sendAt))
      .catch(() => undefined);
  }
  await audit(user.id, "draft.send_undone", {
    draftId,
    threadId: mailbox.threadId,
    mailAccountId: mailbox.mailAccountId,
  });
  revalidatePath(`/thread/${mailbox.threadId}`);
  return { ok: true };
}

/** "Edit" on a failed send: back to an editable draft (acknowledges a possible send). */
export async function editFailedSendAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const draftId = String(formData.get("draftId") ?? "");
  const threadId = String(formData.get("threadId") ?? "");
  if (!UUID.test(draftId) || !UUID.test(threadId)) return;
  await reopenFailedSend(getDb(), user.id, draftId, new Date());
  revalidatePath(`/thread/${threadId}`);
}
```
A `"use server"` module may export only async functions; the exported `SendActionResult` type is erased at build time and is allowed.

In `apps/web/src/app/(app)/thread/[id]/actions.ts`, import `hasActiveSend` from `@replywise/db` and add to `generateDraftAction` right after the `hasFreshPendingDraft` line:
```ts
  // A confirmed send of this thread is running: no regenerate until it ends (spec M6 §2.1).
  if (await hasActiveSend(getDb(), user.id, threadId)) return;
```
(Editing, saving and discarding are already refused by the conditional updates for `scheduled`/`sending`.)

- [ ] **Step 5: Client components (with a test)**

Create `apps/web/src/components/thread/send-countdown.tsx`:
```tsx
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { undoSendAction } from "@/app/(app)/thread/[id]/send-actions";
import { Button } from "@/components/ui/button";
import { sendActionError } from "@/lib/draft-messages";

/** "Sending in N s… Undo" during the 10-second undo window. */
export function SendCountdown({ draftId, sendAt }: { draftId: string; sendAt: string }) {
  const router = useRouter();
  const target = new Date(sendAt).getTime();
  // null until mounted: the server cannot know the client's clock (no hydration mismatch).
  const [left, setLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [target]);
  const text =
    left === null ? "Sending in a few seconds…" : left > 0 ? `Sending in ${left} s…` : "Sending…";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="text-sm font-medium">
        {text}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await undoSendAction({ draftId });
            if (result.ok) router.refresh();
            else setError(sendActionError(result.error));
          })
        }
      >
        Undo
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

Create `apps/web/src/components/thread/send-controls.tsx`:
```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { scheduleSendAction } from "@/app/(app)/thread/[id]/send-actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { sendActionError } from "@/lib/draft-messages";

const PREVIEW_CHARS = 300;

/** "Send…" plus the confirmation dialog (spec M6 §2.2 step 1). */
export function SendControls({
  draftId,
  savedBody,
  to,
  subject,
  label = "Send…",
  disabled = false,
}: {
  draftId: string;
  /** The stored (decrypted) body: what will be sent and what the action re-checks. */
  savedBody: string;
  to: string;
  subject: string;
  label?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (next) {
      // The editor is the draft's textarea; unsaved edits must be saved before sending.
      const field = document.getElementById(`draft-body-${draftId}`);
      const current =
        field instanceof HTMLTextAreaElement ? field.value.replace(/\r\n?/g, "\n") : savedBody;
      setDirty(current !== savedBody);
      setError(null);
    }
    setOpen(next);
  }

  const preview =
    savedBody.length > PREVIEW_CHARS ? `${savedBody.slice(0, PREVIEW_CHARS)}…` : savedBody;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send this reply?</AlertDialogTitle>
          <AlertDialogDescription>
            Replywise sends it from your Gmail account after a 10-second chance to undo. Your
            signature is added at the end.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dirty ? (
          <p role="alert" className="text-sm text-destructive">
            You have unsaved edits. Click "Save edits" first, then send.
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">To</dt>
              <dd className="break-all">{to}</dd>
              <dt className="text-muted-foreground">Subject</dt>
              <dd>{subject}</dd>
            </dl>
            <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2">
              {preview}
            </p>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
          {dirty ? null : (
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await scheduleSendAction({ draftId, expectedBody: savedBody });
                  if (result.ok) {
                    setOpen(false);
                    router.refresh();
                  } else {
                    setError(sendActionError(result.error));
                  }
                })
              }
            >
              {pending ? "Sending…" : "Send now"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```
The confirm button is a plain `Button`, not `AlertDialogAction` (which would close the dialog before the action resolves; same reason as `DisconnectButton`).

Create `apps/web/src/components/thread/send-controls.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SendControls } from "./send-controls";

const { scheduleSendAction, refresh } = vi.hoisted(() => ({
  scheduleSendAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/app/(app)/thread/[id]/send-actions", () => ({ scheduleSendAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const BODY = "Hi Ada,\n\nYes.";

function renderWithEditor(value: string) {
  render(
    <>
      <textarea id="draft-body-d1" aria-label="Reply draft" defaultValue={value} />
      <SendControls draftId="d1" savedBody={BODY} to="Ada <ada@x.com>" subject="Re: Contract" />
    </>,
  );
}

describe("SendControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduleSendAction.mockResolvedValue({ ok: true });
  });

  it("shows recipient, subject and body, then confirms the stored body", async () => {
    renderWithEditor(BODY);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Ada <ada@x.com>");
    expect(dialog).toHaveTextContent("Re: Contract");
    expect(dialog).toHaveTextContent("Yes.");
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(scheduleSendAction).toHaveBeenCalledWith({ draftId: "d1", expectedBody: BODY });
    expect(refresh).toHaveBeenCalled();
  });

  it("asks to save unsaved edits first and offers no Send now", async () => {
    renderWithEditor("Hi Ada,\n\nNo.");
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("unsaved edits");
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("shows the fixed copy when the action refuses", async () => {
    scheduleSendAction.mockResolvedValue({ ok: false, error: "send_rate_limited" });
    renderWithEditor(BODY);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("20 replies");
  });
});
```

- [ ] **Step 6: The composer, thread view and page**

`apps/web/src/components/thread/reply-composer.tsx`:
- Imports: add `import { editFailedSendAction } from "@/app/(app)/thread/[id]/send-actions";`, `import { SendControls } from "@/components/thread/send-controls";`, `import { SendCountdown } from "@/components/thread/send-countdown";`, and `sendFailure` to the `@/lib/draft-messages` import.
- Replace `DraftView` with:
```ts
/** Draft data safe for rendering: the body is already decrypted, never the ciphertext. */
export interface DraftView {
  id: string;
  status:
    | "pending"
    | "generated"
    | "edited"
    | "saved"
    | "failed"
    | "scheduled"
    | "sending"
    | "sent"
    | "send_failed";
  /** Decrypted body; null for pending and failed drafts. */
  body: string | null;
  /** Decryption failed: show a discard-only message instead of the editor. */
  unreadable: boolean;
  /** Pending for longer than PENDING_STALE_MS. */
  stuck: boolean;
  error: string | null;
  providerDraftId: string | null;
  /** A save to Gmail is in flight (requested and not stale). */
  saving: boolean;
  savedAt: Date | null;
  /** When a scheduled send leaves its undo window. */
  sendAt: Date | null;
  sentAt: Date | null;
  /** Recipient and subject for the confirmation; null when it cannot be sent (not Gmail, or nobody to answer). */
  sendPreview: { to: string; subject: string } | null;
  /** send_failed with a code that proves nothing was sent: a new confirm is allowed. */
  canResend: boolean;
}
```
- Add these components above `DraftItem`:
```tsx
function ReadOnlyBody({ body }: { body: string | null }) {
  return (
    <p className="w-full whitespace-pre-wrap rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
      {body ?? ""}
    </p>
  );
}

/** scheduled / sending / sent: the draft is locked (spec M6 §2.1). */
function SendStateItem({
  draft,
  gmailThreadHref,
  now,
}: {
  draft: DraftView;
  gmailThreadHref: string | null;
  now: Date;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      <ReadOnlyBody body={draft.body} />
      {draft.status === "scheduled" && draft.sendAt ? (
        <SendCountdown draftId={draft.id} sendAt={draft.sendAt.toISOString()} />
      ) : null}
      {draft.status === "sending" || (draft.status === "scheduled" && !draft.sendAt) ? (
        <p role="status" className="text-sm font-medium">
          Sending…
        </p>
      ) : null}
      {draft.status === "sent" ? (
        <p className="flex flex-wrap items-center gap-x-3 text-sm">
          <span role="status" className="font-medium">
            Sent ✓
          </span>
          {draft.sentAt ? (
            <LocalTime
              iso={draft.sentAt.toISOString()}
              serverText={formatThreadTime(draft.sentAt, now)}
              className="text-xs text-muted-foreground"
            />
          ) : null}
          {gmailThreadHref ? (
            <a
              href={gmailThreadHref}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              Open in Gmail
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function FailedSendItem({ draft, threadId }: { draft: DraftView; threadId: string }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <ReadOnlyBody body={draft.body} />
      <p role="alert" className="text-sm text-destructive">
        {sendFailure(draft.error)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <form action={editFailedSendAction}>
          <input type="hidden" name="draftId" value={draft.id} />
          <input type="hidden" name="threadId" value={threadId} />
          <Button type="submit" size="sm" variant="outline">
            Edit
          </Button>
        </form>
        {draft.canResend && draft.sendPreview && draft.body !== null ? (
          <SendControls
            draftId={draft.id}
            savedBody={draft.body}
            to={draft.sendPreview.to}
            subject={draft.sendPreview.subject}
            label="Try again"
          />
        ) : null}
      </div>
    </div>
  );
}
```
- `DraftItem` gains the prop `gmailThreadHref: string | null`. After the existing `pending || failed || unreadable` branch and before the editor form, add:
```tsx
  if (draft.status === "scheduled" || draft.status === "sending" || draft.status === "sent") {
    return <SendStateItem draft={draft} gmailThreadHref={gmailThreadHref} now={now} />;
  }
  if (draft.status === "send_failed") {
    return <FailedSendItem draft={draft} threadId={threadId} />;
  }
```
- In the editor's button row, after the "Save to Gmail" button:
```tsx
        {draft.sendPreview && draft.body !== null ? (
          <SendControls
            draftId={draft.id}
            savedBody={draft.body}
            to={draft.sendPreview.to}
            subject={draft.sendPreview.subject}
            disabled={draft.saving}
          />
        ) : null}
```
- Replace the note paragraph text with: `Your signature is added when saving or sending. "Send…" asks you to confirm and gives you 10 seconds to undo; nothing is ever sent automatically.`
- `ReplyComposer` gains the prop `gmailThreadHref: string | null`, passes it to `DraftItem`, and hides the generate form while a send runs:
```tsx
  const sendRunning = drafts.some((d) => d.status === "scheduled" || d.status === "sending");
```
```tsx
      {hasValidKey ? (
        sendRunning ? null : (
          <GenerateForm
            threadId={threadId}
            defaultTone={defaultTone}
            regenerate={drafts.length > 0}
          />
        )
      ) : (
```

`apps/web/src/components/thread/thread-view.tsx`: pass to `ReplyComposer`:
```tsx
        gmailThreadHref={
          view.mailbox.provider === "gmail"
            ? gmailThreadUrl(view.mailbox.emailAddress, view.providerThreadId)
            : null
        }
```

`apps/web/src/app/(app)/thread/[id]/page.tsx`:
- Imports: `import { pickReplyTarget, replySubject } from "@replywise/core";` and `RESENDABLE_FAILURES` from `@replywise/db`.
- Before mapping the drafts: `const sendable = view.mailbox.provider === "gmail";` and
```ts
  const recipient = (address: { name: string | null; address: string }) =>
    address.name ? `${address.name} <${address.address}>` : address.address;
```
- In the returned `DraftView` object add:
```ts
          sendAt: d.sendAt,
          sentAt: d.sentAt,
          sendPreview: (() => {
            // Same target rule as the worker (pickReplyTarget), computed server-side.
            const target = sendable ? pickReplyTarget(view.messages, d.forMessageId) : null;
            return target
              ? { to: recipient(target.from), subject: replySubject(view.subject) }
              : null;
          })(),
          canResend:
            status === "send_failed" &&
            (RESENDABLE_FAILURES as readonly string[]).includes(d.error ?? ""),
```
- Extend `pending` so the existing refresher polls during a send:
```ts
  const pending =
    (summary?.status === "pending" && !summaryStuck) ||
    drafts.some(
      (d) =>
        (d.status === "pending" && !d.stuck) ||
        d.saving ||
        d.status === "scheduled" ||
        d.status === "sending",
    );
```

- [ ] **Step 7: Run and see them pass**

Run: `pnpm --filter @replywise/web test && pnpm --filter @replywise/web typecheck && pnpm --filter @replywise/mail test && pnpm format && pnpm lint && pnpm --filter @replywise/web build`
Expected: PASS. The guard's web check stays green (no send endpoint text in the web app).

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): confirm, undo and send states for replies" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web: Sent and Other views, nav counts and the search box

**Files:**
- Modify: `apps/web/src/components/inbox/thread-list.tsx`, `apps/web/src/app/(app)/inbox/page.tsx`, `apps/web/src/app/(app)/inbox/[category]/page.tsx`
- Create: `apps/web/src/app/(app)/sent/page.tsx`, `apps/web/src/app/(app)/other/page.tsx`, `apps/web/src/components/inbox/other-tabs.tsx`
- Create: `apps/web/src/components/inbox/search-box.tsx`, `apps/web/src/components/inbox/search-box.test.tsx`
- Create: `apps/web/src/lib/nav-counts.ts`
- Modify: `apps/web/src/components/app-shell/nav-items.ts` (+ test), `nav-links.tsx` (+ test), `sidebar-content.tsx`, `mobile-nav.tsx`, `app-shell.tsx`, `apps/web/src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: Task 2 `listInboxThreads`, `listSentThreads`, `listOtherThreads`, `countThreadViews`, `ThreadViewCounts`, `OTHER_TABS`, `OtherTab`, `isOtherTab`; Task 3 `SearchThread`, `ThreadLocation`.
- Produces:
  - `ThreadList({ view }: { view: ThreadListView })` with `ThreadListView = { kind: "inbox"; category?: InboxCategory } | { kind: "sent" } | { kind: "other"; tab: OtherTab | null }`.
  - `ThreadRows({ threads, ownEmails, now }: { threads: Array<InboxThread | SearchThread>; ownEmails: string[]; now: Date })` (renders a location badge for search results).
  - `OTHER_TAB_TEXT: Record<OtherTab, string>`, `OtherTabs({ active })`.
  - `SearchBox({ defaultValue? })`: GET form to `/search` (`q`), `/` focuses it.
  - `loadNavCounts(): Promise<ThreadViewCounts | null>`; `NavItem.countKey?: NavCountKey`; `navCount(counts, key): number | null`; `NavLinksView` prop `counts?: ThreadViewCounts | null`; `NavLinks`/`SidebarContent`/`MobileNav`/`AppShell` prop `counts?: Promise<ThreadViewCounts | null>`.

Decisions: nav counts are total thread counts per view (All mail, each AI tab, Other), shown as an `aria-hidden` badge so link names stay "Urgent", "Other", … (tests and screen readers keep the plain label). Sent has no count. Counts load once per full page load (the layout persists across client navigations; `router.refresh()` and Server Actions re-render it).

- [ ] **Step 1: Write the failing tests**

Replace the `buildNavItems` test in `apps/web/src/components/app-shell/nav-items.test.ts`:
```ts
describe("buildNavItems", () => {
  it("lists all mail, every category in precedence order, then Other and Sent", () => {
    expect(buildNavItems().map((i) => [i.label, i.href, i.countKey ?? null])).toEqual([
      ["All mail", "/inbox", "inbox"],
      ["Urgent", "/inbox/urgent", "urgent"],
      ["Important", "/inbox/important", "important"],
      ["Needs Reply", "/inbox/needs-reply", "needs_reply"],
      ["Informational", "/inbox/informational", "informational"],
      ["Low Priority", "/inbox/low-priority", "low_priority"],
      ["Other", "/other", "other"],
      ["Sent", "/sent", null],
    ]);
  });
});

describe("navCount", () => {
  const counts = {
    inbox: 7,
    other: 3,
    categories: { urgent: 1, important: 0, needs_reply: 2, informational: 4, low_priority: 0 },
  };
  it("reads the count for a key, or null without counts or key", () => {
    expect(navCount(counts, "inbox")).toBe(7);
    expect(navCount(counts, "other")).toBe(3);
    expect(navCount(counts, "needs_reply")).toBe(2);
    expect(navCount(counts, undefined)).toBeNull();
    expect(navCount(null, "inbox")).toBeNull();
  });
});
```
(import `navCount` alongside `buildNavItems, isActive`).

Append to `apps/web/src/components/app-shell/nav-links.test.tsx` (import `NavLinksView` too):
```tsx
describe("NavLinksView counts", () => {
  it("shows a hidden count badge without changing link names", () => {
    render(
      <NavLinksView
        items={buildNavItems()}
        label="Mailbox views"
        pathname="/inbox"
        counts={{
          inbox: 12,
          other: 150,
          categories: { urgent: 0, important: 0, needs_reply: 2, informational: 0, low_priority: 0 },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Other" })).toHaveTextContent("99+");
    expect(screen.getByRole("link", { name: "Needs Reply" })).toHaveTextContent("2");
    expect(screen.getByRole("link", { name: "Urgent" })).not.toHaveTextContent(/\d/);
  });
});
```

Create `apps/web/src/components/inbox/search-box.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchBox } from "./search-box";

vi.mock("next/form", () => ({
  default: (props: ComponentProps<"form">) => <form {...props} />,
}));

describe("SearchBox", () => {
  it("focuses on / and keeps the query", async () => {
    render(<SearchBox defaultValue="invoice" />);
    const input = screen.getByRole("searchbox", { name: "Search mail" });
    expect(input).toHaveValue("invoice");
    await userEvent.keyboard("/");
    expect(input).toHaveFocus();
  });

  it("does not steal / typed into another field", async () => {
    render(
      <>
        <textarea aria-label="Reply draft" />
        <SearchBox />
      </>,
    );
    const textarea = screen.getByRole("textbox", { name: "Reply draft" });
    await userEvent.click(textarea);
    await userEvent.keyboard("/");
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue("/");
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @replywise/web test`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/components/app-shell/nav-items.ts`:
```ts
import { CATEGORY_META, INBOX_CATEGORIES, type InboxCategory } from "@replywise/core";
import type { ThreadViewCounts } from "@replywise/db";

export type NavIcon = "inbox" | "settings" | "sent" | "other" | InboxCategory;
export type NavCountKey = "inbox" | "other" | InboxCategory;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  countKey?: NavCountKey;
}

export function buildNavItems(): NavItem[] {
  return [
    { href: "/inbox", label: "All mail", icon: "inbox", countKey: "inbox" },
    ...INBOX_CATEGORIES.map((category) => ({
      href: `/inbox/${CATEGORY_META[category].slug}`,
      label: CATEGORY_META[category].label,
      icon: category,
      countKey: category,
    })),
    { href: "/other", label: "Other", icon: "other", countKey: "other" },
    { href: "/sent", label: "Sent", icon: "sent" },
  ];
}

export function navCount(
  counts: ThreadViewCounts | null | undefined,
  key: NavCountKey | undefined,
): number | null {
  if (!counts || !key) return null;
  if (key === "inbox") return counts.inbox;
  if (key === "other") return counts.other;
  return counts.categories[key];
}
```
Keep `SETTINGS_NAV_ITEM` and `isActive` as they are. (`import type` from `@replywise/db` is erased, so the client bundle never loads the DB package.)

`apps/web/src/components/app-shell/nav-links.tsx`:
- Import `Layers, Send` from `lucide-react`, `use` from `react`, `navCount` from `./nav-items`, and `import type { ThreadViewCounts } from "@replywise/db";`.
- `ICONS` gains `sent: Send, other: Layers`.
- `NavLinksView` props gain `counts?: ThreadViewCounts | null`; inside the link, after `{item.label}`:
```tsx
            {(() => {
              const n = navCount(counts, item.countKey);
              return n ? (
                <span aria-hidden className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {n > 99 ? "99+" : n}
                </span>
              ) : null;
            })()}
```
- Replace `NavLinks` with:
```tsx
/** Reads the current path (and the counts promise). Must render inside <Suspense>. */
export function NavLinks({
  counts,
  ...props
}: NavLinksProps & { counts?: Promise<ThreadViewCounts | null> }) {
  const pathname = usePathname();
  const resolved = counts ? use(counts) : null;
  return <NavLinksView {...props} counts={resolved} pathname={pathname} />;
}
```

`sidebar-content.tsx`: add prop `counts?: Promise<ThreadViewCounts | null>` (type import from `@replywise/db`) and pass it to the primary `NavLinks` only: `<NavLinks items={PRIMARY} label="Mailbox views" onNavigate={onNavigate} {...(counts ? { counts } : {})} />`.
`mobile-nav.tsx` and `app-shell.tsx`: add the same optional `counts` prop and pass it through to `SidebarContent` (and `MobileNav`) with the same conditional spread.

Create `apps/web/src/lib/nav-counts.ts`:
```ts
import "server-only";
import { countThreadViews, type ThreadViewCounts } from "@replywise/db";
import { getSession } from "./auth";
import { getDb } from "./db";

/** Nav badge counts for the signed-in user; null when signed out or on any error. */
export async function loadNavCounts(): Promise<ThreadViewCounts | null> {
  try {
    const session = await getSession();
    if (!session) return null;
    return await countThreadViews(getDb(), session.user.id);
  } catch {
    return null;
  }
}
```

`apps/web/src/app/(app)/layout.tsx`: create the promise without awaiting it and hand it to the shell; the client `NavLinks` unwraps it with `use()` inside its existing `<Suspense>`:
```tsx
import { loadNavCounts } from "@/lib/nav-counts";
```
```tsx
export default function AppLayout({ children }: LayoutProps<"/">) {
  // Not awaited: the nav resolves it inside its own Suspense boundary (cacheComponents).
  const counts = loadNavCounts();
  return (
    <AppShell
      counts={counts}
      accountSlot={
        <Suspense fallback={<UserMenuSkeleton />}>
          <AccountMenu />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  );
}
```
This is the React 19 pattern of passing an unresolved promise from a server component to a client component: `headers()` inside `loadNavCounts` only suspends the nav's own boundary, so the shell still prerenders. Step 4's `next build` verifies it (it must not report uncached data outside `<Suspense>`).

Create `apps/web/src/components/inbox/search-box.tsx`:
```tsx
"use client";
import Form from "next/form";
import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Local search (spec M6 §5.1): GET /search?q=…; "/" focuses it unless the user is typing. */
export function SearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || TYPING_TAGS.has(target.tagName))) return;
      event.preventDefault();
      ref.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <Form action="/search" role="search" className="px-4 pt-4 sm:px-6">
      <label htmlFor="mail-search" className="sr-only">
        Search mail
      </label>
      <Input
        ref={ref}
        id="mail-search"
        name="q"
        type="search"
        defaultValue={defaultValue}
        maxLength={200}
        autoComplete="off"
        placeholder="Search mail (press /)"
      />
    </Form>
  );
}
```

Create `apps/web/src/components/inbox/other-tabs.tsx`:
```tsx
import { OTHER_TABS, type OtherTab } from "@replywise/db";
import Link from "next/link";
import { cn } from "@/lib/utils";

export const OTHER_TAB_TEXT: Record<OtherTab, string> = {
  promotions: "Promotions",
  social: "Social",
  updates: "Updates",
};

export function OtherTabs({ active }: { active: OtherTab | null }) {
  const chips = [
    { href: "/other", label: "All", current: active === null },
    ...OTHER_TABS.map((tab) => ({
      href: `/other?tab=${tab}`,
      label: OTHER_TAB_TEXT[tab],
      current: active === tab,
    })),
  ];
  return (
    <nav aria-label="Gmail tabs" className="flex flex-wrap gap-2 px-4 pt-4 sm:px-6">
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          aria-current={chip.current ? "page" : undefined}
          className={cn(
            "rounded-full border border-border px-3 py-1 text-xs",
            chip.current
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {chip.label}
        </Link>
      ))}
    </nav>
  );
}
```

`apps/web/src/components/inbox/thread-list.tsx`:
- Imports: `type InboxThread, listInboxThreads, listMailAccounts, listOtherThreads, listSentThreads, type OtherTab, type SearchThread, type ThreadLocation` from `@replywise/db`; `type Db` is not needed (use `ReturnType<typeof getDb>`); `import { Badge } from "@/components/ui/badge";`; `import { OTHER_TAB_TEXT } from "@/components/inbox/other-tabs";`.
- Add:
```tsx
export type ThreadListView =
  | { kind: "inbox"; category?: InboxCategory }
  | { kind: "sent" }
  | { kind: "other"; tab: OtherTab | null };

const LOCATION_TEXT: Record<ThreadLocation, string> = {
  inbox: "Inbox",
  other: "Other",
  sent: "Sent",
  archived: "Archived",
};

function loadThreads(
  db: ReturnType<typeof getDb>,
  userId: string,
  view: ThreadListView,
): Promise<InboxThread[]> {
  if (view.kind === "sent") return listSentThreads(db, userId);
  if (view.kind === "other") return listOtherThreads(db, userId, { tab: view.tab });
  return listInboxThreads(db, userId, view.category ? { category: view.category } : {});
}

/** Empty copy for views that are not the main inbox (which has its own sync-aware states). */
function emptyView(view: ThreadListView): { title: string; description: string } | null {
  if (view.kind === "sent") {
    return {
      title: "No sent mail yet",
      description: "Conversations you wrote in during the last 30 days show up here.",
    };
  }
  if (view.kind === "other") {
    return view.tab
      ? {
          title: `Nothing in ${OTHER_TAB_TEXT[view.tab]}`,
          description: "Gmail files this kind of mail under its own tab.",
        }
      : {
          title: "Nothing in Other",
          description: "Promotions, social and update mail you never replied to shows up here.",
        };
  }
  if (view.category) {
    return {
      title: `Nothing in ${CATEGORY_META[view.category].label}`,
      description: CATEGORY_META[view.category].description,
    };
  }
  return null;
}
```
- `ThreadList` signature becomes `export async function ThreadList({ view }: { view: ThreadListView })`. Replace `const threads = await listInboxThreads(…)` and the category empty-state block with:
```tsx
  const threads = await loadThreads(db, user.id, view);
  const empty = threads.length === 0 ? emptyView(view) : null;
  if (empty) return <EmptyInbox title={empty.title} description={empty.description} />;
```
  Keep the existing `threads.length === 0` syncing / needs-attention / caught-up block for the main inbox. Replace the final `<ul>…</ul>` return with `return <ThreadRows threads={threads} ownEmails={ownEmails} now={now} />;`.
- Move the `<ul>…</ul>` markup into:
```tsx
export function ThreadRows({
  threads,
  ownEmails,
  now,
}: {
  threads: Array<InboxThread | SearchThread>;
  ownEmails: string[];
  now: Date;
}) {
  return (
    <ul className="divide-y divide-border">
      {threads.map((thread) => (
        <li key={thread.id}>
          {/* the current <Link>…</Link> row markup moves here verbatim; add the badge below right after the CategoryBadge */}
        </li>
      ))}
    </ul>
  );
}
```
  with the badge:
```tsx
              {"location" in thread ? (
                <Badge variant="outline">{LOCATION_TEXT[thread.location]}</Badge>
              ) : null}
```

`apps/web/src/app/(app)/inbox/page.tsx`: render `<SearchBox />` (import from `@/components/inbox/search-box`) above the banner Suspense, and `<ThreadList view={{ kind: "inbox" }} />`.
`apps/web/src/app/(app)/inbox/[category]/page.tsx`: same `<SearchBox />`, and `<ThreadList view={{ kind: "inbox", category }} />`.

Create `apps/web/src/app/(app)/sent/page.tsx`:
```tsx
import { Suspense } from "react";
import { SearchBox } from "@/components/inbox/search-box";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export const metadata = { title: "Sent" };

export default function SentPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">Sent</h1>
      <SearchBox />
      <Suspense fallback={<ThreadListSkeleton />}>
        <ThreadList view={{ kind: "sent" }} />
      </Suspense>
    </div>
  );
}
```

Create `apps/web/src/app/(app)/other/page.tsx`:
```tsx
import { isOtherTab } from "@replywise/db";
import { Suspense } from "react";
import { OtherTabs } from "@/components/inbox/other-tabs";
import { SearchBox } from "@/components/inbox/search-box";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export const metadata = { title: "Other" };

async function OtherContent({ searchParams }: { searchParams: PageProps<"/other">["searchParams"] }) {
  const raw = (await searchParams).tab;
  const tab = typeof raw === "string" && isOtherTab(raw) ? raw : null;
  return (
    <>
      <OtherTabs active={tab} />
      <ThreadList view={{ kind: "other", tab }} />
    </>
  );
}

export default function OtherPage({ searchParams }: PageProps<"/other">) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">Other</h1>
      <SearchBox />
      <Suspense fallback={<ThreadListSkeleton />}>
        <OtherContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 4: Run and see them pass**

Run: `pnpm --filter @replywise/web test && pnpm --filter @replywise/web typecheck && pnpm format && pnpm lint && pnpm --filter @replywise/web build`
Expected: PASS; the build lists `/sent` and `/other` (`/search` arrives in Task 9) and reports no uncached data outside `<Suspense>`.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): Sent and Other views, nav counts and a search box" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web: the search page and "Search all of Gmail"

**Files:**
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts` (`E2E_FAKE_GMAIL_URL`)
- Modify: `apps/web/src/lib/sync.ts`
- Create: `apps/web/src/lib/search-limit.ts` (+ `search-limit.test.ts`, test helper `search-limit.testing.ts`), `apps/web/src/lib/redis-limiter.ts`, `apps/web/src/lib/search-messages.ts` (+ `search-messages.test.ts`)
- Create: `apps/web/src/app/(app)/search/page.tsx`, `apps/web/src/app/(app)/search/actions.ts` (+ `actions.test.ts`)
- Create: `apps/web/src/components/search/gmail-search.tsx`

**Interfaces:**
- Consumes: Task 3 `searchThreads`, `SEARCH_MIN_CHARS`, `SEARCH_MAX_CHARS`; Task 4 `GmailApiOptions.baseUrl`; Task 5 `searchGmailThreads`, `importThread`, `GMAIL_QUERY_MAX_CHARS`; Task 8 `SearchBox`, `ThreadRows`, `ThreadListSkeleton`; `createProducerConnection` (queue); `listMailAccounts` (db).
- Produces:
  - `webEnvSchema.E2E_FAKE_GMAIL_URL?: string` (loopback URLs only).
  - `getGmailSearchDeps(): SyncDeps` (faster pacer, one rate-limit retry; honours the e2e origin), and `getSyncDeps()` honours it too.
  - `LimiterStore`, `acquireGmailSearchSlot(store, userId, now): Promise<{ ok: true; release(): Promise<void> } | { ok: false }>`, `countGmailRequest(store, userId, now): Promise<boolean>`, `GMAIL_SEARCHES_PER_MINUTE = 30`, `GMAIL_SEARCH_LOCK_MS = 30_000`; `getLimiterStore(): LimiterStore` (Redis).
  - `GmailSearchErrorCode = "invalid_query" | "needs_reauth" | "rate_limited" | "gmail_error"`, `GMAIL_SEARCH_ERRORS`, `gmailSearchErrorCode(error: unknown)`.
  - Server Actions `searchGmailAction(input: { mailAccountId: string; q: string }): Promise<GmailSearchResponse>` and `importGmailThreadAction(input: { mailAccountId: string; providerThreadId: string }): Promise<{ ok: false; error: GmailSearchErrorCode }>` (redirects to `/thread/<id>` on success). `GmailSearchHit = { providerThreadId; subject; from: string; date: string /* ISO */; snippet; localThreadId: string | null }`.

Decisions: an in-flight search that is refused (one already running) reports `rate_limited`, like the per-minute cap. Imports count toward the same 30-per-minute window. `E2E_FAKE_GMAIL_URL` exists so e2e can stand in for Gmail without network access; the schema accepts only `localhost`/`127.0.0.1`, so tokens can never be sent to another host through it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/config/src/env.test.ts`:
```ts
describe("E2E_FAKE_GMAIL_URL", () => {
  const web = {
    ...base,
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "x".repeat(32),
  };
  it("accepts a loopback origin", () => {
    expect(
      parseEnv(webEnvSchema, { ...web, E2E_FAKE_GMAIL_URL: "http://127.0.0.1:4010" })
        .E2E_FAKE_GMAIL_URL,
    ).toBe("http://127.0.0.1:4010");
  });
  it("rejects any other host", () => {
    expect(() =>
      parseEnv(webEnvSchema, { ...web, E2E_FAKE_GMAIL_URL: "https://gmail.example.com" }),
    ).toThrow(EnvValidationError);
  });
});
```

Create `apps/web/src/lib/search-limit.testing.ts` (a test helper, not a test file):
```ts
import type { LimiterStore } from "./search-limit";

/** In-memory LimiterStore for unit tests (TTLs are ignored; tests move `now` instead). */
export function memoryStore(): LimiterStore & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    async setIfAbsent(key) {
      if (keys.has(key)) return false;
      keys.set(key, 1);
      return true;
    },
    async increment(key) {
      const next = (keys.get(key) ?? 0) + 1;
      keys.set(key, next);
      return next;
    },
    async remove(key) {
      keys.delete(key);
    },
  };
}
```

Create `apps/web/src/lib/search-limit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { acquireGmailSearchSlot, countGmailRequest, GMAIL_SEARCHES_PER_MINUTE } from "./search-limit";
import { memoryStore } from "./search-limit.testing";

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

describe("acquireGmailSearchSlot", () => {
  it("allows one search at a time per user", async () => {
    const store = memoryStore();
    const first = await acquireGmailSearchSlot(store, "u1", NOW);
    expect(first.ok).toBe(true);
    expect((await acquireGmailSearchSlot(store, "u1", NOW)).ok).toBe(false);
    expect((await acquireGmailSearchSlot(store, "u2", NOW)).ok).toBe(true);
    if (first.ok) await first.release();
    expect((await acquireGmailSearchSlot(store, "u1", NOW)).ok).toBe(true);
  });

  it("allows 30 Gmail requests per minute, then refuses until the next minute", async () => {
    const store = memoryStore();
    for (let i = 0; i < GMAIL_SEARCHES_PER_MINUTE; i++) {
      expect(await countGmailRequest(store, "u1", NOW)).toBe(true);
    }
    const refused = await acquireGmailSearchSlot(store, "u1", NOW);
    expect(refused.ok).toBe(false);
    // The refused attempt released its lock.
    expect([...store.keys.keys()].some((k) => k.includes(":lock:"))).toBe(false);
    expect((await acquireGmailSearchSlot(store, "u1", NOW + 60_000)).ok).toBe(true);
  });
});
```

Create `apps/web/src/lib/search-messages.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { GMAIL_SEARCH_ERRORS, gmailSearchErrorCode } from "./search-messages";

describe("gmailSearchErrorCode", () => {
  it("maps reauth and rate limits, and everything else to gmail_error", () => {
    const reauth = Object.assign(new Error("Mailbox x must be reconnected"), {
      name: "ReauthRequiredError",
    });
    const limited = Object.assign(new Error("Provider request failed (429)"), {
      name: "ProviderHttpError",
      rateLimited: true,
    });
    const failed = Object.assign(new Error("Provider request failed (500)"), {
      name: "ProviderHttpError",
      rateLimited: false,
    });
    expect(gmailSearchErrorCode(reauth)).toBe("needs_reauth");
    expect(gmailSearchErrorCode(limited)).toBe("rate_limited");
    expect(gmailSearchErrorCode(failed)).toBe("gmail_error");
    expect(gmailSearchErrorCode("boom")).toBe("gmail_error");
  });

  it("has copy for every code", () => {
    for (const code of ["invalid_query", "needs_reauth", "rate_limited", "gmail_error"] as const) {
      expect(GMAIL_SEARCH_ERRORS[code]).toBeTruthy();
    }
  });
});
```

Create `apps/web/src/app/(app)/search/actions.test.ts`:
```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LimiterStore } from "@/lib/search-limit";
import { memoryStore } from "@/lib/search-limit.testing";

const BOX_ID = "44444444-4444-4444-8444-444444444444";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

const { store, syncMocks, redirect } = vi.hoisted(() => ({
  store: { current: null as LimiterStore | null },
  syncMocks: {
    GMAIL_QUERY_MAX_CHARS: 200,
    importThread: vi.fn(),
    searchGmailThreads: vi.fn(),
  },
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/redis-limiter", () => ({ getLimiterStore: () => store.current }));
vi.mock("@/lib/sync", () => ({ getGmailSearchDeps: () => ({}) }));
vi.mock("@replywise/sync", () => syncMocks);
vi.mock("next/navigation", () => ({ redirect }));

import { importGmailThreadAction, searchGmailAction } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  store.current = memoryStore();
  syncMocks.searchGmailThreads.mockResolvedValue([
    {
      providerThreadId: "g1",
      subject: "Old invoice",
      from: { name: "Billing", address: "billing@vendor.example" },
      date: new Date("2024-03-01T10:00:00Z"),
      snippet: "Your invoice",
      localThreadId: null,
    },
  ]);
});

describe("searchGmailAction", () => {
  it("returns plain hits and frees the in-flight slot", async () => {
    const result = await searchGmailAction({ mailAccountId: BOX_ID, q: " invoice " });
    expect(result).toEqual({
      ok: true,
      hits: [
        {
          providerThreadId: "g1",
          subject: "Old invoice",
          from: "Billing",
          date: "2024-03-01T10:00:00.000Z",
          snippet: "Your invoice",
          localThreadId: null,
        },
      ],
    });
    expect(syncMocks.searchGmailThreads).toHaveBeenCalledWith(
      {},
      { userId: "user-1", mailAccountId: BOX_ID, query: "invoice" },
    );
    expect((await searchGmailAction({ mailAccountId: BOX_ID, q: "x" })).ok).toBe(true);
  });

  it("rejects empty, long or malformed input without calling Gmail", async () => {
    for (const input of [
      { mailAccountId: BOX_ID, q: "  " },
      { mailAccountId: BOX_ID, q: "a".repeat(201) },
      { mailAccountId: "nope", q: "invoice" },
    ]) {
      expect(await searchGmailAction(input)).toEqual({ ok: false, error: "invalid_query" });
    }
    expect(syncMocks.searchGmailThreads).not.toHaveBeenCalled();
  });

  it("returns a fixed code, never the provider's text", async () => {
    syncMocks.searchGmailThreads.mockRejectedValue(
      Object.assign(new Error("secret invoice text"), { name: "ReauthRequiredError" }),
    );
    const result = await searchGmailAction({ mailAccountId: BOX_ID, q: "invoice" });
    expect(result).toEqual({ ok: false, error: "needs_reauth" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("refuses the 31st search in a minute", async () => {
    // Pin the clock so the loop cannot straddle a minute boundary.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T12:00:10Z"));
    for (let i = 0; i < 30; i++) {
      expect((await searchGmailAction({ mailAccountId: BOX_ID, q: "x" })).ok).toBe(true);
    }
    expect(await searchGmailAction({ mailAccountId: BOX_ID, q: "x" })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    vi.useRealTimers();
  });
});

describe("importGmailThreadAction", () => {
  it("imports and redirects to the local thread", async () => {
    syncMocks.importThread.mockResolvedValue(THREAD_ID);
    await expect(
      importGmailThreadAction({ mailAccountId: BOX_ID, providerThreadId: "g1" }),
    ).rejects.toThrow(`NEXT_REDIRECT /thread/${THREAD_ID}`);
    expect(syncMocks.importThread).toHaveBeenCalledWith(
      {},
      { userId: "user-1", mailAccountId: BOX_ID, providerThreadId: "g1" },
    );
  });

  it("reports gmail_error when Gmail no longer has the thread, and validates ids", async () => {
    syncMocks.importThread.mockResolvedValue(null);
    expect(
      await importGmailThreadAction({ mailAccountId: BOX_ID, providerThreadId: "g1" }),
    ).toEqual({ ok: false, error: "gmail_error" });
    expect(
      await importGmailThreadAction({ mailAccountId: BOX_ID, providerThreadId: "../x" }),
    ).toEqual({ ok: false, error: "invalid_query" });
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @replywise/config test && pnpm --filter @replywise/web test`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/config/src/env.ts`, extend `webEnvSchema`:
```ts
  /** e2e only: a loopback origin standing in for gmail.googleapis.com. Never another host. */
  E2E_FAKE_GMAIL_URL: z
    .url()
    .refine(
      (value) => ["localhost", "127.0.0.1"].includes(new URL(value).hostname),
      "must be a loopback URL",
    )
    .optional(),
```

`apps/web/src/lib/sync.ts`:
```ts
import "server-only";
import { createGmailApi, type GmailApiOptions } from "@replywise/mail";
import type { SyncDeps } from "@replywise/sync";
import { getEnv } from "./env";
import { getMailboxDeps } from "./mailbox";

/** Gmail origin override for e2e (loopback only; validated by the env schema). */
function gmailOrigin(): Pick<GmailApiOptions, "baseUrl"> {
  const url = getEnv().E2E_FAKE_GMAIL_URL;
  return url ? { baseUrl: url } : {};
}

export function getSyncDeps(): SyncDeps {
  return {
    ...getMailboxDeps(),
    gmail: (accessToken) => createGmailApi(accessToken, gmailOrigin()),
  };
}

/**
 * Interactive "Search all of Gmail": one short burst per click (list + 20 metadata reads), so a
 * faster pacer than sync and a single rate-limit retry keep the page responsive.
 */
export function getGmailSearchDeps(): SyncDeps {
  return {
    ...getMailboxDeps(),
    gmail: (accessToken) =>
      createGmailApi(accessToken, { ...gmailOrigin(), unitsPerSecond: 200, maxRetries: 1 }),
  };
}
```

Create `apps/web/src/lib/search-limit.ts`:
```ts
/** Minimal Redis surface the limiter needs (injectable for tests). */
export interface LimiterStore {
  /** SET key NX with a TTL; true when this call created the key. */
  setIfAbsent(key: string, ttlMs: number): Promise<boolean>;
  /** INCR with a TTL; returns the new value. */
  increment(key: string, ttlMs: number): Promise<number>;
  remove(key: string): Promise<void>;
}

export const GMAIL_SEARCHES_PER_MINUTE = 30;
/** One search's upper bound; the lock expires by itself if a request dies. */
export const GMAIL_SEARCH_LOCK_MS = 30_000;
const MINUTE_MS = 60_000;

export type GmailSearchSlot = { ok: true; release: () => Promise<void> } | { ok: false };

/** Counts one Gmail request (search or import) in the user's current minute; false over the cap. */
export async function countGmailRequest(
  store: LimiterStore,
  userId: string,
  now: number,
): Promise<boolean> {
  const window = Math.floor(now / MINUTE_MS);
  const count = await store.increment(`rw:gmail-search:count:${userId}:${window}`, 2 * MINUTE_MS);
  return count <= GMAIL_SEARCHES_PER_MINUTE;
}

/** One in-flight Gmail search per user and at most 30 per minute (spec M6 §5.2). */
export async function acquireGmailSearchSlot(
  store: LimiterStore,
  userId: string,
  now: number,
): Promise<GmailSearchSlot> {
  const lock = `rw:gmail-search:lock:${userId}`;
  if (!(await store.setIfAbsent(lock, GMAIL_SEARCH_LOCK_MS))) return { ok: false };
  if (!(await countGmailRequest(store, userId, now))) {
    await store.remove(lock);
    return { ok: false };
  }
  return { ok: true, release: () => store.remove(lock) };
}
```

Create `apps/web/src/lib/redis-limiter.ts`:
```ts
import "server-only";
import { createProducerConnection } from "@replywise/queue";
import { getEnv } from "./env";
import type { LimiterStore } from "./search-limit";

type Redis = ReturnType<typeof createProducerConnection>;
const globalForLimiter = globalThis as unknown as { replywiseLimiterRedis?: Redis };

/** Redis-backed limiter store: one fail-fast connection per process (survives dev reloads). */
export function getLimiterStore(): LimiterStore {
  globalForLimiter.replywiseLimiterRedis ??= createProducerConnection(getEnv().REDIS_URL);
  const redis = globalForLimiter.replywiseLimiterRedis;
  return {
    async setIfAbsent(key, ttlMs) {
      return (await redis.set(key, "1", "PX", ttlMs, "NX")) === "OK";
    },
    async increment(key, ttlMs) {
      const results = await redis.multi().incr(key).pexpire(key, ttlMs).exec();
      return Number(results?.[0]?.[1] ?? 0);
    },
    async remove(key) {
      await redis.del(key);
    },
  };
}
```

Create `apps/web/src/lib/search-messages.ts`:
```ts
export type GmailSearchErrorCode = "invalid_query" | "needs_reauth" | "rate_limited" | "gmail_error";

export const GMAIL_SEARCH_ERRORS: Record<GmailSearchErrorCode, string> = {
  invalid_query: "Enter a Gmail search of up to 200 characters.",
  needs_reauth: "Gmail needs to be reconnected (Settings → Mailboxes).",
  rate_limited: "Too many Gmail searches right now. Wait a moment and try again.",
  gmail_error: "Gmail couldn't be searched right now. Try again.",
};

/** Fixed code for a failed Gmail search or import; provider text never reaches the UI. */
export function gmailSearchErrorCode(error: unknown): GmailSearchErrorCode {
  if (!(error instanceof Error)) return "gmail_error";
  if (error.name === "ReauthRequiredError") return "needs_reauth";
  if (error.name === "ProviderHttpError" && (error as { rateLimited?: unknown }).rateLimited) {
    return "rate_limited";
  }
  return "gmail_error";
}
```
(Matching on `name` keeps this module free of server packages, so the client component can import the copy.)

Create `apps/web/src/app/(app)/search/actions.ts`:
```ts
"use server";

import { GMAIL_QUERY_MAX_CHARS, importThread, searchGmailThreads } from "@replywise/sync";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getLimiterStore } from "@/lib/redis-limiter";
import { acquireGmailSearchSlot, countGmailRequest } from "@/lib/search-limit";
import { type GmailSearchErrorCode, gmailSearchErrorCode } from "@/lib/search-messages";
import { getGmailSearchDeps } from "@/lib/sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Gmail thread ids are hex; allow the URL-safe alphabet and nothing that could form a path. */
const PROVIDER_THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface GmailSearchHit {
  providerThreadId: string;
  subject: string;
  from: string;
  /** ISO 8601. */
  date: string;
  snippet: string;
  localThreadId: string | null;
}

export type GmailSearchResponse =
  | { ok: true; hits: GmailSearchHit[] }
  | { ok: false; error: GmailSearchErrorCode };

/** "Search all of Gmail" for one of the user's mailboxes. The query is never logged. */
export async function searchGmailAction(input: {
  mailAccountId: string;
  q: string;
}): Promise<GmailSearchResponse> {
  const user = await requireUser();
  const mailAccountId = typeof input?.mailAccountId === "string" ? input.mailAccountId : "";
  const q = typeof input?.q === "string" ? input.q.trim() : "";
  if (!UUID.test(mailAccountId) || q.length === 0 || q.length > GMAIL_QUERY_MAX_CHARS) {
    return { ok: false, error: "invalid_query" };
  }
  let release: () => Promise<void>;
  try {
    const slot = await acquireGmailSearchSlot(getLimiterStore(), user.id, Date.now());
    if (!slot.ok) return { ok: false, error: "rate_limited" };
    release = slot.release;
  } catch {
    return { ok: false, error: "gmail_error" };
  }
  try {
    const results = await searchGmailThreads(getGmailSearchDeps(), {
      userId: user.id,
      mailAccountId,
      query: q,
    });
    return {
      ok: true,
      hits: results.map((r) => ({
        providerThreadId: r.providerThreadId,
        subject: r.subject,
        from: r.from.name ?? r.from.address,
        date: r.date.toISOString(),
        snippet: r.snippet,
        localThreadId: r.localThreadId,
      })),
    };
  } catch (error) {
    return { ok: false, error: gmailSearchErrorCode(error) };
  } finally {
    await release().catch(() => undefined);
  }
}

/** Imports one Gmail thread, then opens it. Only failures return. */
export async function importGmailThreadAction(input: {
  mailAccountId: string;
  providerThreadId: string;
}): Promise<{ ok: false; error: GmailSearchErrorCode }> {
  const user = await requireUser();
  const mailAccountId = typeof input?.mailAccountId === "string" ? input.mailAccountId : "";
  const providerThreadId =
    typeof input?.providerThreadId === "string" ? input.providerThreadId : "";
  if (!UUID.test(mailAccountId) || !PROVIDER_THREAD_ID.test(providerThreadId)) {
    return { ok: false, error: "invalid_query" };
  }
  try {
    if (!(await countGmailRequest(getLimiterStore(), user.id, Date.now()))) {
      return { ok: false, error: "rate_limited" };
    }
  } catch {
    return { ok: false, error: "gmail_error" };
  }
  let threadId: string | null;
  try {
    threadId = await importThread(getGmailSearchDeps(), {
      userId: user.id,
      mailAccountId,
      providerThreadId,
    });
  } catch (error) {
    return { ok: false, error: gmailSearchErrorCode(error) };
  }
  if (!threadId) return { ok: false, error: "gmail_error" };
  // Outside the try: redirect() works by throwing.
  redirect(`/thread/${threadId}`);
}
```

Create `apps/web/src/components/search/gmail-search.tsx`:
```tsx
"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import {
  type GmailSearchHit,
  importGmailThreadAction,
  searchGmailAction,
} from "@/app/(app)/search/actions";
import { Button } from "@/components/ui/button";
import { GMAIL_SEARCH_ERRORS } from "@/lib/search-messages";

interface Mailbox {
  id: string;
  emailAddress: string;
}

/** "Search all of Gmail": one button per connected Gmail mailbox (spec M6 §5.2). */
export function GmailSearch({ q, mailboxes }: { q: string; mailboxes: Mailbox[] }) {
  return (
    <section
      aria-label="Search all of Gmail"
      className="flex flex-col gap-4 border-t border-border px-4 py-4 sm:px-6"
    >
      {mailboxes.map((mailbox) => (
        <MailboxSearch key={mailbox.id} q={q} mailbox={mailbox} showEmail={mailboxes.length > 1} />
      ))}
    </section>
  );
}

function MailboxSearch({ q, mailbox, showEmail }: { q: string; mailbox: Mailbox; showEmail: boolean }) {
  const [hits, setHits] = useState<GmailSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const search = () =>
    startTransition(async () => {
      setError(null);
      const result = await searchGmailAction({ mailAccountId: mailbox.id, q });
      if (result.ok) {
        setHits(result.hits);
      } else {
        setHits(null);
        setError(GMAIL_SEARCH_ERRORS[result.error]);
      }
    });

  const importHit = (hit: GmailSearchHit) =>
    startTransition(async () => {
      setError(null);
      // Success redirects to the imported thread; only failures come back.
      const result = await importGmailThreadAction({
        mailAccountId: mailbox.id,
        providerThreadId: hit.providerThreadId,
      });
      setError(GMAIL_SEARCH_ERRORS[result.error]);
    });

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={search}>
          {showEmail ? `Search all of Gmail (${mailbox.emailAddress})` : "Search all of Gmail"}
        </Button>
      </div>
      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Working with Gmail…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {hits !== null && hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Gmail results.</p>
      ) : null}
      {hits && hits.length > 0 ? (
        <ul
          aria-label="Gmail results"
          className="divide-y divide-border rounded-lg border border-border"
        >
          {hits.map((hit) => (
            <li key={hit.providerThreadId} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{hit.subject || "(no subject)"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {hit.from} · {new Date(hit.date).toLocaleDateString()}
                </p>
                <p className="truncate text-sm text-muted-foreground">{hit.snippet}</p>
              </div>
              {hit.localThreadId ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/thread/${hit.localThreadId}`}>Open</Link>
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={pending} onClick={() => importHit(hit)}>
                  Import
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

Create `apps/web/src/app/(app)/search/page.tsx`:
```tsx
import { listMailAccounts, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, searchThreads } from "@replywise/db";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { SearchBox } from "@/components/inbox/search-box";
import { ThreadListSkeleton, ThreadRows } from "@/components/inbox/thread-list";
import { GmailSearch } from "@/components/search/gmail-search";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const metadata = { title: "Search" };

async function SearchContent({ searchParams }: { searchParams: PageProps<"/search">["searchParams"] }) {
  const user = await requireUser();
  const raw = (await searchParams).q;
  const q = (typeof raw === "string" ? raw : "").trim().slice(0, SEARCH_MAX_CHARS);
  await connection();
  const db = getDb();
  const [mailboxes, results] = await Promise.all([
    listMailAccounts(db, user.id),
    searchThreads(db, user.id, q),
  ]);
  const gmail = mailboxes
    .filter((m) => m.provider === "gmail")
    .map((m) => ({ id: m.id, emailAddress: m.emailAddress }));
  const searchable = q.length >= SEARCH_MIN_CHARS;
  return (
    <>
      <SearchBox defaultValue={q} />
      {!searchable ? (
        <p className="px-4 py-4 text-sm text-muted-foreground sm:px-6">
          Type at least 2 characters to search subjects, senders and previews.
        </p>
      ) : results.length === 0 ? (
        <EmptyInbox
          title="No matches in Replywise"
          description="Replywise searches subjects, senders and previews of synced mail. Try searching all of Gmail below."
        />
      ) : (
        <ThreadRows
          threads={results}
          ownEmails={mailboxes.map((m) => m.emailAddress)}
          now={new Date()}
        />
      )}
      {searchable && gmail.length > 0 ? <GmailSearch key={q} q={q} mailboxes={gmail} /> : null}
    </>
  );
}

export default function SearchPage({ searchParams }: PageProps<"/search">) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">Search</h1>
      <Suspense fallback={<ThreadListSkeleton />}>
        <SearchContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 4: Run and see them pass**

Run: `pnpm --filter @replywise/config test && pnpm --filter @replywise/web test && pnpm --filter @replywise/web typecheck && pnpm --filter @replywise/mail test && pnpm format && pnpm lint && pnpm --filter @replywise/web build`
Expected: PASS; `/search` is listed by the build.

- [ ] **Step 5: Commit**

```bash
git add packages/config apps/web
git commit -m "feat(web): local search page and Search all of Gmail with import" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: e2e for sending, views and search

**Files:**
- Create: `apps/web/e2e/fake-gmail.ts`, `apps/web/e2e/send.spec.ts`, `apps/web/e2e/views.spec.ts`, `apps/web/e2e/gmail-search.spec.ts`
- Modify: `apps/web/e2e/seed.ts`, `apps/web/playwright.config.ts`

No worker runs during e2e. Actions that enqueue (`draft.send`) write to Redis and nothing consumes them, so the specs assert the scheduled UI and Undo, and seed `sent` / `send_failed` rows for the other states. Gmail search and import go to a local fake Gmail on `127.0.0.1:4010` through `E2E_FAKE_GMAIL_URL`.

- [ ] **Step 1: Seed helpers, the fake Gmail and the config**

`apps/web/e2e/seed.ts`:
- `thread` input gains `labels?: string[]` (default unchanged: `["INBOX", "UNREAD"]` when unread, else `["INBOX"]`) and `replied?: boolean`. Use `providerLabels: input.labels ?? (input.unread ? ["INBOX", "UNREAD"] : ["INBOX"])`. When `replied`, after the first message insert a second one:
```ts
        if (input.replied) {
          await db.insert(messages).values({
            threadId: thread.id,
            mailAccountId,
            providerMessageId: `seed-${Math.random().toString(36).slice(2)}`,
            fromAddress: { name: "Me", address: "me@example.com" },
            subject: input.subject,
            snippet: "My reply",
            sentAt: new Date(sentAt.getTime() + 60_000),
            isFromUser: true,
          });
        }
```
- `draft` input `status` gains `"scheduled" | "sending" | "sent" | "send_failed"`, plus `sendAt?: Date` and `sentAt?: Date`; add `sendAt: input.sendAt ?? null, sentAt: input.sentAt ?? null,` to the insert values. (Seeding these values at runtime is fine: migration 0003 committed them long before.)
- New method `gmailMailbox(userEmail: string): Promise<string>` (add it to the `withSeed` parameter type too):
```ts
      async gmailMailbox(userEmail) {
        const [user] = await db.select().from(users).where(eq(users.email, userEmail));
        if (!user) throw new Error(`no user ${userEmail}`);
        const [row] = await db
          .insert(mailAccounts)
          .values({
            userId: user.id,
            provider: "gmail",
            emailAddress: `seed-${Date.now()}@gmail.com`,
            tokensCiphertext: Buffer.from("pending"),
            lastSyncedAt: new Date(),
          })
          .returning({ id: mailAccounts.id });
        if (!row) throw new Error("seed gmail mailbox failed");
        // Real, decryptable tokens far from expiry: the web app calls the fake Gmail with them.
        const tokens = {
          accessToken: FAKE_GMAIL_TOKEN,
          refreshToken: "e2e-refresh-token",
          expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        };
        await db
          .update(mailAccounts)
          .set({
            tokensCiphertext: await encryptor.encrypt(
              JSON.stringify(tokens),
              aad.mailTokens(row.id),
            ),
          })
          .where(eq(mailAccounts.id, row.id));
        return row.id;
      },
```
  with `import { FAKE_GMAIL_TOKEN } from "./fake-gmail";`.

Create `apps/web/e2e/fake-gmail.ts`:
```ts
import { createServer, type Server } from "node:http";

export const FAKE_GMAIL_PORT = 4010;
export const FAKE_GMAIL_TOKEN = "e2e-access-token";

export interface FakeGmailThread {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  body: string;
  date: Date;
}

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function message(thread: FakeGmailThread, format: string) {
  const headers = [
    { name: "Subject", value: thread.subject },
    { name: "From", value: thread.from },
    { name: "To", value: "me@gmail.com" },
    { name: "Date", value: thread.date.toUTCString() },
    { name: "Message-ID", value: `<${thread.id}@fake.example>` },
  ];
  return {
    id: `${thread.id}-m1`,
    threadId: thread.id,
    labelIds: ["INBOX"],
    snippet: thread.snippet,
    internalDate: String(thread.date.getTime()),
    payload:
      format === "full"
        ? { mimeType: "text/plain", headers, body: { size: thread.body.length, data: b64url(thread.body) } }
        : { mimeType: "text/plain", headers },
  };
}

/** Minimal Gmail API double: threads.list and threads.get (metadata or full). Read-only. */
export async function startFakeGmail(port: number, threads: FakeGmailThread[]) {
  const queries: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return reply(405, { error: { code: 405 } });
    if (req.headers.authorization !== `Bearer ${FAKE_GMAIL_TOKEN}`) {
      return reply(401, { error: { code: 401 } });
    }
    if (url.pathname === "/gmail/v1/users/me/threads") {
      queries.push(url.searchParams.get("q") ?? "");
      return reply(200, {
        threads: threads.map((t) => ({ id: t.id, snippet: t.snippet })),
        resultSizeEstimate: threads.length,
      });
    }
    const match = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    const thread = match ? threads.find((t) => t.id === decodeURIComponent(match[1] ?? "")) : undefined;
    if (thread) {
      return reply(200, {
        id: thread.id,
        messages: [message(thread, url.searchParams.get("format") ?? "full")],
      });
    }
    return reply(404, { error: { code: 404 } });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    queries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

`apps/web/playwright.config.ts`, in `webServer.env` add:
```ts
      E2E_FAKE_GMAIL_URL: process.env.E2E_FAKE_GMAIL_URL || "http://127.0.0.1:4010",
```
(If a local server is reused via `reuseExistingServer`, it must have been started with that variable.)

- [ ] **Step 2: Specs**

Create `apps/web/e2e/send.spec.ts`:
```ts
import { expect, type Page, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

// Several role=status elements can be visible at once, and Next's route announcer is role=alert,
// so always filter by text.
const status = (scope: Page | ReturnType<Page["getByRole"]>, text: string | RegExp) =>
  scope.getByRole("status").filter({ hasText: text });
const alert = (scope: Page | ReturnType<Page["getByRole"]>, text: string | RegExp) =>
  scope.getByRole("alert").filter({ hasText: text });

async function setup(page: Page, provider: "gmail" | "outlook" = "gmail") {
  const email = await signUp(page);
  const threadId = await withSeed(async (seed) => {
    await seed.aiKey(email);
    const box = await seed.mailbox(email, { provider, lastSyncedAt: new Date() });
    return seed.thread(box, {
      subject: "Contract to sign",
      snippet: "Please sign by Friday",
      text: "Hi, please sign the contract by Friday.",
    });
  });
  return { email, threadId };
}

test("Send asks for confirmation, and Undo returns the draft to editing", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nSigned." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await composer.getByRole("button", { name: "Send…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("ada@example.com");
  await expect(dialog).toContainText("Re: Contract to sign");
  await expect(dialog).toContainText("Signed.");
  await dialog.getByRole("button", { name: "Send now" }).click();

  await expect(status(composer, /Sending in/)).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toHaveCount(0);
  await composer.getByRole("button", { name: "Undo" }).click();

  const body = composer.getByRole("textbox", { name: "Reply draft" });
  await expect(body).toHaveValue("Hi Ada,\n\nSigned.");
  await body.fill("Hi Ada,\n\nSigned and attached.");
  await composer.getByRole("button", { name: "Save edits" }).click();
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Reply" }).getByRole("textbox", { name: "Reply draft" }),
  ).toHaveValue("Hi Ada,\n\nSigned and attached.");
});

test("unsaved edits must be saved before sending", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nSigned." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await composer.getByRole("textbox", { name: "Reply draft" }).fill("Changed");
  await composer.getByRole("button", { name: "Send…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(alert(dialog, "unsaved edits")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send now" })).toHaveCount(0);
});

test("a sent reply is locked and links to Gmail", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, {
      status: "sent",
      body: "Hi Ada,\n\nSigned.",
      providerDraftId: "r-1",
      sentAt: new Date(),
    }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(status(composer, "Sent ✓")).toBeVisible();
  await expect(composer.getByRole("link", { name: "Open in Gmail" })).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Send…" })).toHaveCount(0);
});

test("an unconfirmed send explains itself and Edit reopens the draft", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, {
      status: "send_failed",
      body: "Hi Ada,\n\nSigned.",
      error: "send_unconfirmed",
    }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(alert(composer, "may or may not have gone out")).toBeVisible();
  await expect(composer.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await composer.getByRole("button", { name: "Edit" }).click();
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toHaveValue(
    "Hi Ada,\n\nSigned.",
  );
});

test("Outlook drafts offer no Send", async ({ page }) => {
  const { email, threadId } = await setup(page, "outlook");
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nSigned." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Send…" })).toHaveCount(0);
});
```

Create `apps/web/e2e/views.spec.ts`:
```ts
import { expect, type Page, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

async function seedViews(page: Page) {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    const box = await seed.mailbox(email, { lastSyncedAt: new Date() });
    await seed.thread(box, { subject: "Contract to sign", snippet: "Please sign by Friday" });
    await seed.thread(box, {
      subject: "Weekly sale",
      snippet: "Everything 50% off",
      labels: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    await seed.thread(box, {
      subject: "Order shipped",
      snippet: "Your order is on its way",
      labels: ["CATEGORY_UPDATES", "INBOX"],
      replied: true,
    });
    await seed.thread(box, {
      subject: "Proposal sent",
      snippet: "Here is the proposal",
      labels: ["SENT"],
    });
  });
}

test("Gmail tab mail moves to Other unless the user replied", async ({ page }) => {
  await seedViews(page);
  await page.goto("/inbox");
  const main = page.getByRole("main");
  await expect(main.getByText("Contract to sign")).toBeVisible();
  await expect(main.getByText("Order shipped")).toBeVisible();
  await expect(main.getByText("Weekly sale")).toHaveCount(0);
  await expect(main.getByText("Proposal sent")).toHaveCount(0);

  const other = page.getByRole("navigation", { name: "Mailbox views" }).getByRole("link", {
    name: "Other",
  });
  await expect(other).toContainText("1");
  await other.click();
  await expect(page).toHaveURL(/\/other$/);
  await expect(main.getByText("Weekly sale")).toBeVisible();
  await page.getByRole("navigation", { name: "Gmail tabs" }).getByRole("link", { name: "Social" }).click();
  await expect(page.getByText("Nothing in Social")).toBeVisible();
});

test("Sent lists the threads the user wrote in", async ({ page }) => {
  await seedViews(page);
  await page.goto("/sent");
  const main = page.getByRole("main");
  await expect(main.getByText("Proposal sent")).toBeVisible();
  await expect(main.getByText("Contract to sign")).toHaveCount(0);
});

test("local search finds threads everywhere and says where they live", async ({ page }) => {
  await seedViews(page);
  await page.goto("/inbox");
  await page.keyboard.press("/");
  await page.keyboard.type("sale");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=sale$/);
  const row = page.getByRole("link", { name: /Weekly sale/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Other");

  await page.goto("/search?q=proposal");
  await expect(page.getByRole("link", { name: /Proposal sent/ })).toContainText("Sent");
  await page.goto("/search?q=p");
  await expect(page.getByText("Type at least 2 characters")).toBeVisible();
});
```

Create `apps/web/e2e/gmail-search.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { FAKE_GMAIL_PORT, startFakeGmail } from "./fake-gmail";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

let fake: Awaited<ReturnType<typeof startFakeGmail>>;

test.beforeAll(async () => {
  fake = await startFakeGmail(FAKE_GMAIL_PORT, [
    {
      id: "g1old",
      subject: "Old invoice 2024",
      from: "Billing <billing@vendor.example>",
      snippet: "Your invoice is attached",
      body: "Invoice total: 120 EUR",
      date: new Date("2024-03-01T10:00:00Z"),
    },
  ]);
});
test.afterAll(async () => fake.close());

test("Search all of Gmail finds an old thread, imports it and then links to it", async ({ page }) => {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    await seed.gmailMailbox(email);
  });
  await page.goto("/search?q=invoice");
  await expect(page.getByText("No matches in Replywise")).toBeVisible();
  await page.getByRole("button", { name: "Search all of Gmail" }).click();
  const results = page.getByRole("list", { name: "Gmail results" });
  await expect(results).toContainText("Old invoice 2024");
  await results.getByRole("button", { name: "Import" }).click();

  await expect(page).toHaveURL(/\/thread\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Old invoice 2024" })).toBeVisible();
  await expect(page.getByText("Invoice total: 120 EUR")).toBeVisible();

  await page.goto("/search?q=invoice");
  await expect(page.getByRole("link", { name: /Old invoice 2024/ })).toBeVisible();
  await page.getByRole("button", { name: "Search all of Gmail" }).click();
  await expect(
    page.getByRole("list", { name: "Gmail results" }).getByRole("link", { name: "Open" }),
  ).toBeVisible();
  expect(fake.queries).toContain("invoice");
});
```

- [ ] **Step 3: Run**

Make sure :3000 and :4010 are free and Postgres/Redis are up, then run: `pnpm --filter @replywise/web e2e --reporter=line --workers=1`
Expected: PASS (30 → about 41). If a locator needs adjusting, change the locator, not the product behaviour; the rendered copy is fixed by Tasks 7 to 9.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e apps/web/playwright.config.ts
git commit -m "test(web): e2e for confirmed send, Sent and Other views, and search" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, full verification and one real send

**Files:**
- Modify: `README.md`, `docs/superpowers/notes/2026-11-16-m2-followups.md`

- [ ] **Step 1: Document**

In `README.md`, replace the sentence "**Replywise never sends email** — open the draft in Gmail to review and send it yourself." in "Summaries and reply drafts" with "You can also send the reply from Replywise (see below)." and append:
````markdown
## Sending replies, Sent, Other and search

- **Send (Gmail only).** Under a draft, click **Send…**. The dialog shows the recipient, the subject and the start of the reply; **Send now** waits 10 seconds with an **Undo** button, then Replywise saves the Gmail draft and sends it with Gmail's send-draft call. Nothing is ever sent without that click: AI jobs and auto-draft never send. At most 20 sends per hour. If Gmail's answer is lost (timeout, 5xx), the reply is marked "may or may not have gone out" and is never retried automatically — check Gmail's Sent folder, then choose **Edit**.
- **Sent.** Sync now brings in the last 30 days of Inbox **and** Sent; the **Sent** view lists conversations you wrote in.
- **Other.** Gmail's Promotions, Social and Updates mail you never replied to is kept out of All mail and the AI tabs, is never auto-classified, and is listed under **Other** (with tab filters).
- **Search.** Press `/` (or use the box above the list) to search subjects, senders and previews of everything synced. **Search all of Gmail** runs your query (Gmail syntax) against the mailbox and lets you **Import** an older thread. Message bodies are not searched locally.

No new Google scope is needed: `gmail.compose` already allows sending drafts.
````

In the followups note, add an `## M6 decisions to revisit` section:
```markdown
- Sending uses Gmail drafts/send after a 10 s undo window; only a rate limit (before the call or as Gmail's answer) is retried. Any other failure of the send call is `send_unconfirmed` (5xx, timeout, network, malformed success) or `send_rejected` (4xx) and is never retried.
- A `send_attempted` marker in `reply_drafts.error` is set just before the send call and cleared only on a rate-limit answer, so a crashed or duplicate job never calls Gmail twice; such rows become `send_unconfirmed` after 10 minutes.
- Scheduled sends that never ran within 10 minutes of `send_at` (job lost and not recovered) fail as `internal` (nothing was sent; "Try again" is offered). Overdue ones (> 60 s) are re-enqueued first with the same job id.
- "Try again" is offered for every send_failed code that proves nothing was sent (send_rejected and the M5 save codes), not only send_rejected.
- The send dialog refuses to confirm while the editor has unsaved edits ("Save edits" first), so the confirmed body is always the stored one; the action re-checks it (`draft_changed`).
- Sends run on their own `send` queue (concurrency 2) so AI jobs never delay a confirmed send.
- The stuck-send scan is its own minutely job (`maintenance.recoverSends`), not part of an existing one.
- The no-send guard's `/send` pattern no longer matches module paths like `./jobs/send-draft` (needed for the spec's file name); every `…/send` endpoint is still blocked.
- "Other" = INBOX + a Promotions/Social/Updates label + no message from the user. The Other view shows INBOX threads only; archived tab mail is found by search. Classification is skipped only in the minutely scan (sync never enqueued classification since M4).
- Nav counts are total threads per view, as `aria-hidden` badges; they refresh on full loads and Server Actions, not on every client navigation.
- Local search uses ILIKE + pg_trgm on subject, snippet and a generated `participants_text`; no body search, limit 50, newest first.
- Gmail search: one in-flight search per user plus 30 Gmail requests per minute (searches and imports share the window), Redis fixed-minute counters. A recent inbox thread imported by hand is classified like any synced thread; old imports never are.
- `E2E_FAKE_GMAIL_URL` (loopback only) points the web app's Gmail client at the e2e fake.
- Deferred: Outlook sending/search/import, reply-all, attachments, a setting for which Gmail tabs are hidden.
```

- [ ] **Step 2: Full automated verification**

```bash
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test && pnpm test:int && pnpm --filter @replywise/web e2e --reporter=line --workers=1
```
Expected: everything passes, including all five no-send guard tests.

- [ ] **Step 3: Manual verification with the real Gmail account** (user present; start the worker and web app in the user's own terminals because of memory pressure)

1. Let one sync run (or wait 2 minutes). **Sent** lists recent conversations the user wrote in; **Other** lists promotions; All mail no longer shows them.
2. Search `/` for a known sender: results show with Inbox/Sent/Other badges. **Search all of Gmail** for an older subject, **Import** it, and the thread opens.
3. Open a thread from the user's **own second address** (or send yourself a mail from another account first). Generate or type a reply, **Save edits**, click **Send…**: the dialog shows that address, "Re: <subject>" and the body. Click **Send now**, then **Undo** within 10 s: the draft is editable again and nothing arrives.
4. Click **Send…** → **Send now** again and wait: "Sent ✓" appears. In Gmail, the reply is in **Sent**, in the same conversation, with the signature, addressed only to the original sender, and no leftover draft.
5. Settings → nothing new; the audit log has `draft.send_scheduled`, `draft.send_undone`, `draft.sent` rows without body or recipient: `select action, metadata from audit_logs order by created_at desc limit 5;`.
6. Worker logs contain no draft text, subjects, addresses or search queries: `grep -E "@|sk-ant" <worker log>` returns nothing but ids.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/notes/2026-11-16-m2-followups.md
git commit -m "docs: document sending, Sent, Other and search and record M6 decisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Definition of done (M6)

- A Gmail reply is sent only after **Send…** → confirmation → 10 s undo window; Undo returns it to editing; the worker sends it exactly once via drafts/send and never retries after the request may have reached Gmail. Sent, failed (unconfirmed/rejected) and stuck states render with their fixed copy, and at most 20 sends per user per hour are allowed.
- `drafts/send` exists only in `packages/mail/src/gmail-send.ts`, `createGmailSendApi` is imported only by `apps/worker/src/jobs/send-draft.ts`, and the guard test enforces both.
- The backfill covers Inbox and Sent; the Sent view lists `SENT` threads; sent-only threads are never classified.
- Promotions/Social/Updates threads the user never wrote in are hidden from All mail, the AI tabs and their counts, listed under Other with tab chips, and skipped by auto-classification.
- Local search matches subject, snippet and participants with escaped `ILIKE` on pg_trgm indexes; Search all of Gmail returns metadata results per Gmail mailbox and imports threads, rate-limited per user, with fixed error codes and no query logging.
- Migration 0003 applies cleanly; all automated suites pass; one real reply was sent from Replywise and verified in Gmail Sent.
