# Replywise M3 — Gmail Sync, Inbox and Thread View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connected Gmail mailboxes are synced by the worker (30-day backfill, then incremental every 2 minutes), stored with envelope-encrypted, expiring body caches, and shown in the web app as an inbox thread list and a thread view that renders sanitized email HTML in a sandboxed frame.

**Architecture:** `@replywise/mail` gains a pure MIME/Gmail parser and a read-only Gmail API client. A new `@replywise/sync` package owns the sync engine (lease → token → backfill or history → one DB transaction) and thread loading for the UI. The worker runs one `mailbox.sync` job per mailbox through BullMQ job schedulers kept in step with the database by a reconcile job; the web app only reads the database (and refetches expired bodies on demand). Outlook sync is a later milestone.

**Tech Stack:** As M1/M2 (TypeScript, pnpm 11, Turborepo, Vitest 5, Next.js 16.4 with `cacheComponents`, Drizzle 0.45, BullMQ 6, Playwright). New dependency: `sanitize-html` (web only).

**Spec:** `docs/superpowers/specs/2026-11-15-replywise-design.md` — §4 (threads/messages/body cache), §7 (sync and background processing), §8 (XSS via email HTML, cross-tenant access, never send). M2 follow-ups that this plan must absorb: `docs/superpowers/notes/2026-11-16-m2-followups.md` → "Carry into the M3 (sync) plan".

## Global Constraints

- Gmail only in M3. Outlook mailboxes are skipped by the sync engine (`unsupported_provider`) and not scheduled.
- **Replywise never sends email.** Only these Gmail endpoints are called: `users/me/profile`, `users/me/threads` (list), `users/me/threads/{id}?format=full`, `users/me/history`. The no-send guard test must cover `packages/mail/src`, `packages/mailbox/src`, `packages/sync/src` and `apps/worker/src`.
- Backfill: last 30 days of inbox threads (`in:inbox newer_than:30d`), capped at 300 threads per mailbox. Incremental: `history.list(startHistoryId)`; HTTP 404 (history expired) → bounded re-backfill.
- Upserts are idempotent on `(mail_account_id, provider_thread_id)` and `(mail_account_id, provider_message_id)`; the new cursor (Gmail `historyId`) is stored **in the same transaction** as the upserts.
- Bodies: stored only as envelope-encrypted JSON `{text, html}` with AAD `aad.messageBody(messageId)`, expiring after `user_preferences.body_cache_days` (default 14); HTML capped at 256,000 chars, text at 128,000. The existing hourly `maintenance.purgeBodies` job purges expired bodies; the thread view refetches them on demand.
- One sync at a time per mailbox: a database lease (`mail_accounts.sync_lease_until`, 10 minutes). Job payloads carry ids only.
- `getValidAccessToken` must not take the row lock while the stored token is fresh, must never be called inside an open transaction on the same mailbox, and a successful refresh must not overwrite `status`/`last_error`.
- `last_error` holds only fixed, non-secret strings (no provider messages, no email content).
- Email HTML is sanitized server-side (no scripts, event handlers, `javascript:` URLs, forms, styles, or remote images) and rendered in an `<iframe sandbox>` without `allow-scripts`. AI-free in M3: threads are not classified (M4).
- Every query the web app runs is scoped by the signed-in `userId`.
- Next.js 16 rules: session/DB/`params`/`searchParams` reads inside `<Suspense>`; `headers()` before env/DB; no `force-dynamic`.
- Infra: Postgres/Redis run from the main checkout's compose project — never run `docker compose up` from a worktree. Docker CLI: `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`.
- Commit after every task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map (M3)

```
packages/mailbox/src/access-token.ts            (fast path, no status clobber)
packages/mailbox/src/{access-token,disconnect}.int.test.ts (new cases)
packages/mail/src/mime/{encoded-words,addresses,html-entities,gmail-message}.ts   NEW (+ .test.ts each)
packages/mail/src/gmail-api.ts                  NEW (+ gmail-api.test.ts)
packages/mail/src/no-send.test.ts               (scan more dirs)
packages/db/src/schema/mail.ts                  (+ syncLeaseUntil) + migrations/0001_sync_lease.sql
packages/db/src/queries/{sync,threads}.ts       NEW (+ sync.int.test.ts, threads.int.test.ts)
packages/sync/                                  NEW package
  src/{index,deps,errors,concurrency,body-codec,thread-summary,persist,sync-mailbox,thread-view,testing}.ts
  src/{concurrency,thread-summary}.test.ts  src/{sync-mailbox,thread-view}.int.test.ts
packages/queue/src/{jobs,bullmq}.ts             (+ mailbox.sync, reconcile job, list/remove schedulers)
apps/worker/src/{deps,main}.ts, src/jobs/{sync-mailbox,reconcile-sync-schedules}.ts
apps/web/src/lib/{sync,inbox-format,email-html}.ts (+ tests)
apps/web/src/components/inbox/thread-list.tsx, src/components/thread/{thread-view,email-frame}.tsx
apps/web/src/components/mailboxes/mailbox-list.tsx (sync status)
apps/web/src/app/(app)/inbox/page.tsx, src/app/(app)/thread/[id]/page.tsx
apps/web/e2e/{inbox.spec.ts, seed.ts}
README.md
```

---

### Task 1: Token access fast path and M2 test gaps

**Files:**
- Modify: `packages/mailbox/src/access-token.ts`
- Test: `packages/mailbox/src/access-token.int.test.ts`, `packages/mailbox/src/disconnect.int.test.ts`

**Interfaces:**
- Consumes: existing `MailboxDeps`, `decryptTokens`, `encryptTokens`, `createFakeProvider(id, options)` (options include `refreshError`, `refreshDelayMs`), `testEncryptor()`.
- Produces: `getValidAccessToken(deps, mailAccountId)` — same signature and errors as before; now (a) reads without a lock while the token is fresh, (b) leaves `status`/`last_error` untouched on a successful refresh.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mailbox/src/access-token.int.test.ts` (inside the existing `describe("getValidAccessToken", …)`; the file already has `connected()`, `T0`, `MIN`, `db`):
```ts
  it("does not wait for the row lock while the token is fresh", async () => {
    const { at, mailAccountId } = await connected();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId)).for("update");
      locked();
      await gate;
    });
    await lockTaken;
    const result = await Promise.race([
      getValidAccessToken(at(new Date(T0.getTime() + 10 * MIN)), mailAccountId),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]);
    release();
    await holder;
    expect(result).toEqual({ accessToken: "access-1", provider: "gmail" });
  });

  it("keeps an error status and message when a refresh succeeds", async () => {
    const { at, mailAccountId } = await connected();
    await db
      .update(mailAccounts)
      .set({ status: "error", lastError: "Gmail API request failed (500)" })
      .where(eq(mailAccounts.id, mailAccountId));
    const result = await getValidAccessToken(at(new Date(T0.getTime() + 58 * MIN)), mailAccountId);
    expect(result.accessToken).toBe("access-2");
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
    expect(account).toMatchObject({ status: "error", lastError: "Gmail API request failed (500)" });
  });

  it("leaves tokens and status unchanged when refresh fails for another reason", async () => {
    const { fake, at, mailAccountId } = await connected({ refreshError: "temporarily_unavailable" });
    const later = at(new Date(T0.getTime() + 2 * 60 * MIN));
    await expect(getValidAccessToken(later, mailAccountId)).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
    expect(account?.status).toBe("active");
    expect(fake.calls.refresh).toBe(1);
    await expect(getValidAccessToken(later, mailAccountId)).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    expect(fake.calls.refresh).toBe(2);
  });
```
Add `mailAccounts` and `eq` imports if missing (`import { auditLogs, type Db, mailAccounts } from "@replywise/db"; import { eq } from "drizzle-orm";` — the file already imports both in M2; keep a single import line each).

In `packages/mailbox/src/disconnect.int.test.ts`, extend the existing test "refuses to disconnect another user's mailbox" so that after the rejection it also asserts:
```ts
    expect(fake.calls.revoke).toBe(0);
    expect(
      (await db.select().from(auditLogs)).filter((a) => a.action === "mailbox.disconnected"),
    ).toHaveLength(0);
```
(destructure `fake` from `connect("gmail", true)` in that test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/mailbox test:int`
Expected: "does not wait for the row lock…" FAILS (`"blocked"`); "keeps an error status…" FAILS (status becomes `active`). The other new assertions may already pass.

- [ ] **Step 3: Implement**

Replace the body of `getValidAccessToken` in `packages/mailbox/src/access-token.ts` (keep imports, `REFRESH_SKEW_MS`, `REAUTH_MESSAGE`, `Outcome`):
```ts
function isFresh(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() - REFRESH_SKEW_MS > now.getTime();
}

/**
 * Returns a usable access token, refreshing it when it expires within 5 minutes.
 * Fresh tokens are read without locking. Refreshes run under a row lock (SELECT … FOR UPDATE)
 * and re-check freshness after acquiring it, so concurrent callers never refresh twice —
 * important for Microsoft, which rotates refresh tokens. A successful refresh never changes
 * the mailbox status or last error (sync owns those).
 *
 * NOT user-scoped: call only from trusted server code with an id from a trusted source, and
 * never from inside an open transaction that touches the same mailbox row.
 */
export async function getValidAccessToken(
  deps: MailboxDeps,
  mailAccountId: string,
): Promise<{ accessToken: string; provider: MailProviderId }> {
  const [current] = await deps.db
    .select({
      id: mailAccounts.id,
      status: mailAccounts.status,
      provider: mailAccounts.provider,
      tokensCiphertext: mailAccounts.tokensCiphertext,
    })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, mailAccountId));
  if (!current) throw new MailAccountNotFoundError(mailAccountId);
  if (current.status === "needs_reauth") throw new ReauthRequiredError(mailAccountId);
  const stored = await decryptTokens(deps.encryptor, current.id, current.tokensCiphertext);
  if (isFresh(stored.expiresAt, clock(deps))) {
    return { accessToken: stored.accessToken, provider: current.provider };
  }

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
    if (isFresh(tokens.expiresAt, now)) {
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
          grantedScopes:
            grant.grantedScopes.length > 0 ? grant.grantedScopes : account.grantedScopes,
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mailbox test:int && pnpm --filter @replywise/mailbox typecheck && pnpm lint`
Expected: 21 tests PASS (18 + 3); the existing concurrency test still passes; typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(mailbox): unlocked fast path for fresh tokens; refresh no longer clobbers status"
```

---

### Task 2: `@replywise/mail` — MIME header, address and Gmail message parsing

**Files:**
- Create: `packages/mail/src/mime/{encoded-words,addresses,html-entities,gmail-message}.ts`
- Modify: `packages/mail/src/index.ts`
- Test: `packages/mail/src/mime/{encoded-words,addresses,gmail-message}.test.ts`

**Interfaces:**
- Consumes: `EmailAddress` from `@replywise/core`.
- Produces: `decodeEncodedWords(value: string): string`; `parseAddressList(value: string | undefined): EmailAddress[]`; `decodeHtmlEntities(value: string): string`; types `GmailMessagePart`, `GmailMessageResource`, `ParsedMessage`, `ParsedThread`; `parseGmailMessage(resource: GmailMessageResource): ParsedMessage`; constants `MAX_BODY_HTML_CHARS = 256_000`, `MAX_BODY_TEXT_CHARS = 128_000`.

- [ ] **Step 1: Write the failing tests**

`packages/mail/src/mime/encoded-words.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decodeEncodedWords } from "./encoded-words";

describe("decodeEncodedWords", () => {
  it("decodes base64 (B) encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?w4lsw6huZQ==?=")).toBe("Élène");
  });

  it("decodes quoted-printable (Q) encoded words in other charsets", () => {
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9_cr=E8me?=")).toBe("Café crème");
  });

  it("ignores whitespace between adjacent encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Hello?= =?UTF-8?Q?_World?=")).toBe("Hello World");
  });

  it("keeps surrounding plain text and leaves plain values untouched", () => {
    expect(decodeEncodedWords("Re: =?UTF-8?Q?caf=C3=A9?= tomorrow")).toBe("Re: café tomorrow");
    expect(decodeEncodedWords("Just text")).toBe("Just text");
  });

  it("leaves words with unknown charsets as they are", () => {
    expect(decodeEncodedWords("=?x-unknown?Q?abc?=")).toBe("=?x-unknown?Q?abc?=");
  });
});
```

`packages/mail/src/mime/addresses.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseAddressList } from "./addresses";

describe("parseAddressList", () => {
  it("parses names and lowercases addresses", () => {
    expect(parseAddressList("Ada Lovelace <Ada@Example.com>")).toEqual([
      { name: "Ada Lovelace", address: "ada@example.com" },
    ]);
  });

  it("keeps commas inside quoted names and handles bare addresses", () => {
    expect(parseAddressList('"Doe, John" <john@x.com>, jane@y.com')).toEqual([
      { name: "Doe, John", address: "john@x.com" },
      { name: null, address: "jane@y.com" },
    ]);
  });

  it("decodes encoded-word names and escaped quotes", () => {
    expect(parseAddressList("=?UTF-8?B?w4lsw6huZQ==?= <e@x.com>")).toEqual([
      { name: "Élène", address: "e@x.com" },
    ]);
    expect(parseAddressList('"Quote \\"Q\\" Person" <q@x.com>')).toEqual([
      { name: 'Quote "Q" Person', address: "q@x.com" },
    ]);
  });

  it("drops groups and empty input", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });
});
```

`packages/mail/src/mime/gmail-message.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { type GmailMessageResource, parseGmailMessage } from "./gmail-message";

const b64 = (s: string, encoding: BufferEncoding = "utf8") =>
  Buffer.from(s, encoding).toString("base64url");

function message(overrides: Partial<GmailMessageResource> = {}): GmailMessageResource {
  return {
    id: "msg-1",
    threadId: "thread-1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Can we meet &amp; talk? It&#39;s urgent",
    internalDate: "1763380800000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Ada Lovelace <Ada@Example.com>" },
        { name: "To", value: "me@gmail.com, Bob <bob@x.com>" },
        { name: "Cc", value: "carol@y.com" },
        { name: "Subject", value: "=?UTF-8?Q?Caf=C3=A9_plans?=" },
        { name: "Message-ID", value: "<abc@mail.example.com>" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
              body: { data: b64("Hello Ada") },
            },
            {
              mimeType: "text/html",
              headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
              body: { data: b64("<p>Hello <b>Ada</b></p>") },
            },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "agenda.pdf",
          body: { attachmentId: "att-1", size: 1024 },
        },
      ],
    },
    ...overrides,
  };
}

describe("parseGmailMessage", () => {
  it("extracts headers, addresses, labels, bodies and attachments", () => {
    const parsed = parseGmailMessage(message());
    expect(parsed).toMatchObject({
      providerMessageId: "msg-1",
      providerThreadId: "thread-1",
      internetMessageId: "<abc@mail.example.com>",
      from: { name: "Ada Lovelace", address: "ada@example.com" },
      to: [
        { name: null, address: "me@gmail.com" },
        { name: "Bob", address: "bob@x.com" },
      ],
      cc: [{ name: null, address: "carol@y.com" }],
      subject: "Café plans",
      snippet: "Can we meet & talk? It's urgent",
      labelIds: ["INBOX", "UNREAD"],
      hasAttachments: true,
      bodyText: "Hello Ada",
      bodyHtml: "<p>Hello <b>Ada</b></p>",
    });
    expect(parsed.sentAt.toISOString()).toBe("2025-11-17T12:00:00.000Z");
  });

  it("decodes non-UTF-8 body charsets", () => {
    const parsed = parseGmailMessage(
      message({
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "a@x.com" },
            { name: "Content-Type", value: "text/plain; charset=ISO-8859-1" },
          ],
          body: { data: b64("Café", "latin1") },
        },
      }),
    );
    expect(parsed.bodyText).toBe("Café");
    expect(parsed.bodyHtml).toBeNull();
    expect(parsed.hasAttachments).toBe(false);
  });

  it("handles single-part HTML messages and missing headers", () => {
    const parsed = parseGmailMessage(
      message({
        labelIds: undefined,
        snippet: undefined,
        payload: { mimeType: "text/html", body: { data: b64("<i>hi</i>") } },
      }),
    );
    expect(parsed).toMatchObject({
      from: { name: null, address: "" },
      to: [],
      subject: "",
      snippet: "",
      labelIds: [],
      bodyText: null,
      bodyHtml: "<i>hi</i>",
      internetMessageId: null,
    });
  });

  it("falls back to the Date header when internalDate is missing", () => {
    const parsed = parseGmailMessage(
      message({
        internalDate: undefined,
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Date", value: "Mon, 17 Nov 2025 09:30:00 +0000" }],
          body: { data: b64("x") },
        },
      }),
    );
    expect(parsed.sentAt.toISOString()).toBe("2025-11-17T09:30:00.000Z");
  });

  it("caps very large bodies", () => {
    const parsed = parseGmailMessage(
      message({
        payload: { mimeType: "text/plain", body: { data: b64("a".repeat(200_000)) } },
      }),
    );
    expect(parsed.bodyText).toHaveLength(128_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/mail test`
Expected: FAIL — cannot resolve `./encoded-words`, `./addresses`, `./gmail-message`.

- [ ] **Step 3: Implement**

`packages/mail/src/mime/encoded-words.ts`:
```ts
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
const ADJACENT_GAP = /(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g;

function decodeQ(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const hex = text.slice(i + 1, i + 3);
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else out.push(ch.charCodeAt(0));
  }
  return Uint8Array.from(out);
}

function normalizeCharset(charset: string): string {
  const lower = (charset.split("*")[0] ?? charset).toLowerCase();
  return lower === "utf8" ? "utf-8" : lower;
}

/** Decodes RFC 2047 encoded words (`=?charset?B|Q?…?=`); leaves anything else untouched. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(ADJACENT_GAP, "$1")
    .replace(ENCODED_WORD, (match, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQ(text);
        return new TextDecoder(normalizeCharset(charset)).decode(bytes);
      } catch {
        return match;
      }
    });
}
```

`packages/mail/src/mime/addresses.ts`:
```ts
import type { EmailAddress } from "@replywise/core";
import { decodeEncodedWords } from "./encoded-words";

function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\" && inQuotes) {
      current += ch + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "<") depth++;
    else if (!inQuotes && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !inQuotes && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function cleanName(raw: string): string | null {
  let name = decodeEncodedWords(raw.trim());
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  name = name.trim();
  return name === "" ? null : name;
}

function parseOne(raw: string): EmailAddress | null {
  const text = raw.trim();
  if (text === "") return null;
  const angle = /^([\s\S]*)<([^<>]+)>\s*$/.exec(text);
  if (angle) {
    const address = (angle[2] ?? "").trim().toLowerCase();
    return address.includes("@") ? { name: cleanName(angle[1] ?? ""), address } : null;
  }
  const address = text.replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();
  return address.includes("@") && !/\s/.test(address) ? { name: null, address } : null;
}

/** Parses an RFC 5322 address-list header value ("Name <a@b>, c@d"). Groups are dropped. */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  return splitAddresses(value)
    .map(parseOne)
    .filter((a): a is EmailAddress => a !== null);
}
```

`packages/mail/src/mime/html-entities.ts`:
```ts
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the entities Gmail puts in snippets (&amp; &#39; &#x27; …). Text only. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });
}
```

`packages/mail/src/mime/gmail-message.ts`:
```ts
import type { EmailAddress } from "@replywise/core";
import { parseAddressList } from "./addresses";
import { decodeEncodedWords } from "./encoded-words";
import { decodeHtmlEntities } from "./html-entities";

export const MAX_BODY_HTML_CHARS = 256_000;
export const MAX_BODY_TEXT_CHARS = 128_000;

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface ParsedMessage {
  providerMessageId: string;
  providerThreadId: string;
  internetMessageId: string | null;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  snippet: string;
  sentAt: Date;
  labelIds: string[];
  hasAttachments: boolean;
  bodyText: string | null;
  bodyHtml: string | null;
}

export interface ParsedThread {
  providerThreadId: string;
  messages: ParsedMessage[];
}

function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function charsetOf(part: GmailMessagePart): string {
  const contentType = header(part.headers, "Content-Type") ?? "";
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return (match?.[1] ?? "utf-8").toLowerCase();
}

function decodeBody(part: GmailMessagePart): string | null {
  const data = part.body?.data;
  if (!data) return null;
  const bytes = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isAttachment(part: GmailMessagePart): boolean {
  if (part.filename) return true;
  const disposition = header(part.headers, "Content-Disposition") ?? "";
  return /^\s*attachment/i.test(disposition);
}

function walk(part: GmailMessagePart, visit: (p: GmailMessagePart) => void): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function sentAtOf(resource: GmailMessageResource, dateHeader: string | undefined): Date {
  const internal = Number(resource.internalDate);
  if (resource.internalDate && Number.isFinite(internal)) return new Date(internal);
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(0);
}

/** Converts a Gmail `format=full` message into Replywise's provider-neutral shape. */
export function parseGmailMessage(resource: GmailMessageResource): ParsedMessage {
  const payload = resource.payload ?? {};
  const headers = payload.headers;
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;
  let hasAttachments = false;

  walk(payload, (part) => {
    if (isAttachment(part)) {
      hasAttachments = true;
      return;
    }
    const type = (part.mimeType ?? "").toLowerCase();
    if (type === "text/plain" && bodyText === null) bodyText = decodeBody(part);
    else if (type === "text/html" && bodyHtml === null) bodyHtml = decodeBody(part);
  });

  const messageId = header(headers, "Message-ID")?.trim();
  return {
    providerMessageId: resource.id,
    providerThreadId: resource.threadId,
    internetMessageId: messageId ? messageId : null,
    from: parseAddressList(header(headers, "From"))[0] ?? { name: null, address: "" },
    to: parseAddressList(header(headers, "To")),
    cc: parseAddressList(header(headers, "Cc")),
    subject: decodeEncodedWords(header(headers, "Subject") ?? "").trim(),
    snippet: decodeHtmlEntities(resource.snippet ?? ""),
    sentAt: sentAtOf(resource, header(headers, "Date")),
    labelIds: resource.labelIds ?? [],
    hasAttachments,
    bodyText: bodyText === null ? null : (bodyText as string).slice(0, MAX_BODY_TEXT_CHARS),
    bodyHtml: bodyHtml === null ? null : (bodyHtml as string).slice(0, MAX_BODY_HTML_CHARS),
  };
}
```

Append to `packages/mail/src/index.ts`:
```ts
export * from "./mime/addresses";
export * from "./mime/encoded-words";
export * from "./mime/gmail-message";
export * from "./mime/html-entities";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mail test && pnpm --filter @replywise/mail typecheck && pnpm format && pnpm lint`
Expected: 39 tests PASS (25 + 5 + 4 + 5); typecheck and lint exit 0. (If Biome rewrites the `as string` casts in `parseGmailMessage`, keep its version as long as types still check.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mail): parse MIME headers, address lists and Gmail messages"
```

---

### Task 3: `@replywise/mail` — read-only Gmail API client and wider no-send guard

**Files:**
- Create: `packages/mail/src/gmail-api.ts`
- Modify: `packages/mail/src/index.ts`, `packages/mail/src/no-send.test.ts`
- Test: `packages/mail/src/gmail-api.test.ts`

**Interfaces:**
- Consumes: `getJson`, `ProviderHttpError` (http.ts), `parseGmailMessage`, `ParsedThread`, `GmailMessageResource` (Task 2), `FetchLike`.
- Produces: `class HistoryExpiredError extends Error`; `interface HistoryPage { changedThreadIds: string[]; deletedMessageIds: string[]; historyId: string; nextPageToken: string | null }`; `interface GmailApi { getProfile(): Promise<{ emailAddress: string; historyId: string }>; listThreadIds(input: { query: string; maxResults: number; pageToken?: string }): Promise<{ ids: string[]; nextPageToken: string | null }>; getThread(threadId: string): Promise<ParsedThread | null>; listHistory(input: { startHistoryId: string; pageToken?: string }): Promise<HistoryPage> }`; `createGmailApi(accessToken: string, options?: { fetch?: FetchLike }): GmailApi`; `type GmailApiFactory = (accessToken: string) => GmailApi`.

- [ ] **Step 1: Write the failing test**

`packages/mail/src/gmail-api.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createGmailApi, HistoryExpiredError } from "./gmail-api";
import type { FetchLike } from "./types";

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: new URL(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("createGmailApi", () => {
  it("reads the profile history id with a bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { emailAddress: "Me@Gmail.com", historyId: "12345", messagesTotal: 9 } },
    ]);
    const api = createGmailApi("ya29.token", { fetch: fetchImpl });
    expect(await api.getProfile()).toEqual({ emailAddress: "me@gmail.com", historyId: "12345" });
    expect(calls[0]?.url.toString()).toBe(`${BASE}/profile`);
    expect(calls[0]?.headers.authorization).toBe("Bearer ya29.token");
  });

  it("lists thread ids with query, page size and page token", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { threads: [{ id: "t1" }, { id: "t2" }], nextPageToken: "p2" } },
      { body: { resultSizeEstimate: 0 } },
    ]);
    const api = createGmailApi("tok", { fetch: fetchImpl });
    expect(await api.listThreadIds({ query: "in:inbox newer_than:30d", maxResults: 100 })).toEqual({
      ids: ["t1", "t2"],
      nextPageToken: "p2",
    });
    expect(await api.listThreadIds({ query: "q", maxResults: 50, pageToken: "p2" })).toEqual({
      ids: [],
      nextPageToken: null,
    });
    expect(calls[0]?.url.pathname).toBe("/gmail/v1/users/me/threads");
    expect(calls[0]?.url.searchParams.get("q")).toBe("in:inbox newer_than:30d");
    expect(calls[0]?.url.searchParams.get("maxResults")).toBe("100");
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("gets a full thread, parses messages oldest first, and returns null when it is gone", async () => {
    const message = (id: string, internalDate: string) => ({
      id,
      threadId: "t1",
      internalDate,
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "From", value: "a@x.com" }],
        body: { data: b64(id) },
      },
    });
    const { fetchImpl, calls } = fakeFetch([
      { body: { id: "t1", messages: [message("m2", "2000"), message("m1", "1000")] } },
      { status: 404, body: { error: { code: 404 } } },
    ]);
    const api = createGmailApi("tok", { fetch: fetchImpl });
    const thread = await api.getThread("t1");
    expect(thread?.providerThreadId).toBe("t1");
    expect(thread?.messages.map((m) => m.providerMessageId)).toEqual(["m1", "m2"]);
    expect(calls[0]?.url.pathname).toBe("/gmail/v1/users/me/threads/t1");
    expect(calls[0]?.url.searchParams.get("format")).toBe("full");
    expect(await api.getThread("gone")).toBeNull();
  });

  it("collects changed threads and deleted messages from history", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          historyId: "200",
          nextPageToken: "h2",
          history: [
            { id: "150", messagesAdded: [{ message: { id: "m9", threadId: "t9" } }] },
            {
              id: "160",
              labelsAdded: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["UNREAD"] }],
              labelsRemoved: [{ message: { id: "m9", threadId: "t9" }, labelIds: ["INBOX"] }],
              messagesDeleted: [{ message: { id: "m3", threadId: "t3" } }],
            },
          ],
        },
      },
    ]);
    const api = createGmailApi("tok", { fetch: fetchImpl });
    expect(await api.listHistory({ startHistoryId: "100" })).toEqual({
      changedThreadIds: ["t9", "t1", "t3"],
      deletedMessageIds: ["m3"],
      historyId: "200",
      nextPageToken: "h2",
    });
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/gmail/v1/users/me/history");
    expect(url?.searchParams.get("startHistoryId")).toBe("100");
    expect(url?.searchParams.getAll("historyTypes")).toEqual([
      "messageAdded",
      "messageDeleted",
      "labelAdded",
      "labelRemoved",
    ]);
  });

  it("reports an expired history id distinctly", async () => {
    const { fetchImpl } = fakeFetch([{ status: 404, body: { error: { code: 404 } } }]);
    const api = createGmailApi("tok", { fetch: fetchImpl });
    await expect(api.listHistory({ startHistoryId: "1" })).rejects.toBeInstanceOf(
      HistoryExpiredError,
    );
  });
});
```

Replace the scan setup in `packages/mail/src/no-send.test.ts` so it covers every package and app that talks to providers (existing patterns and the `createReply` test stay unchanged). The directory list becomes:
```ts
const ROOTS = [
  join(import.meta.dirname, "."),
  join(import.meta.dirname, "../../mailbox/src"),
  join(import.meta.dirname, "../../sync/src"),
  join(import.meta.dirname, "../../../apps/worker/src"),
].filter((dir) => existsSync(dir));
```
(import `existsSync` from `node:fs`; build the `sources` list by scanning every root, keeping the existing "sources found" sanity assertion). `packages/sync/src` does not exist until Task 5; the `existsSync` filter makes the test pass before then and cover it afterwards.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/mail test`
Expected: FAIL — cannot resolve `./gmail-api`.

- [ ] **Step 3: Implement**

`packages/mail/src/gmail-api.ts`:
```ts
import { getJson, ProviderHttpError } from "./http";
import { type GmailMessageResource, type ParsedThread, parseGmailMessage } from "./mime/gmail-message";
import type { FetchLike } from "./types";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const;

/** Gmail no longer has history for the stored startHistoryId (HTTP 404): re-backfill. */
export class HistoryExpiredError extends Error {
  constructor() {
    super("Gmail history expired");
    this.name = "HistoryExpiredError";
  }
}

export interface HistoryPage {
  changedThreadIds: string[];
  deletedMessageIds: string[];
  historyId: string;
  nextPageToken: string | null;
}

/** Read-only Gmail access used by sync. Deliberately has no send or modify capability. */
export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listThreadIds(input: {
    query: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<{ ids: string[]; nextPageToken: string | null }>;
  getThread(threadId: string): Promise<ParsedThread | null>;
  listHistory(input: { startHistoryId: string; pageToken?: string }): Promise<HistoryPage>;
}

export type GmailApiFactory = (accessToken: string) => GmailApi;

type Ref = { message?: { id?: unknown; threadId?: unknown } };

function refs(value: unknown): Ref[] {
  return Array.isArray(value) ? (value as Ref[]) : [];
}

export function createGmailApi(accessToken: string, options: { fetch?: FetchLike } = {}): GmailApi {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const get = (url: URL) => getJson(fetchImpl, url.toString(), accessToken);

  return {
    async getProfile() {
      const body = await get(new URL(`${BASE}/profile`));
      if (typeof body.emailAddress !== "string" || body.historyId === undefined) {
        throw new ProviderHttpError(200, "/gmail/v1/users/me/profile");
      }
      return { emailAddress: body.emailAddress.toLowerCase(), historyId: String(body.historyId) };
    },

    async listThreadIds({ query, maxResults, pageToken }) {
      const url = new URL(`${BASE}/threads`);
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(maxResults));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await get(url);
      const threads = Array.isArray(body.threads) ? (body.threads as Array<{ id?: unknown }>) : [];
      return {
        ids: threads.map((t) => t.id).filter((id): id is string => typeof id === "string"),
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
      };
    },

    async getThread(threadId) {
      const url = new URL(`${BASE}/threads/${encodeURIComponent(threadId)}`);
      url.searchParams.set("format", "full");
      let body: Record<string, unknown>;
      try {
        body = await get(url);
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) return null;
        throw error;
      }
      const messages = Array.isArray(body.messages) ? (body.messages as GmailMessageResource[]) : [];
      return {
        providerThreadId: threadId,
        messages: messages
          .map(parseGmailMessage)
          .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()),
      };
    },

    async listHistory({ startHistoryId, pageToken }) {
      const url = new URL(`${BASE}/history`);
      url.searchParams.set("startHistoryId", startHistoryId);
      for (const type of HISTORY_TYPES) url.searchParams.append("historyTypes", type);
      url.searchParams.set("maxResults", "500");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let body: Record<string, unknown>;
      try {
        body = await get(url);
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) {
          throw new HistoryExpiredError();
        }
        throw error;
      }
      const changed = new Set<string>();
      const deleted = new Set<string>();
      const history = Array.isArray(body.history) ? (body.history as Record<string, unknown>[]) : [];
      for (const entry of history) {
        for (const key of ["messagesAdded", "labelsAdded", "labelsRemoved", "messagesDeleted"]) {
          for (const ref of refs(entry[key])) {
            if (typeof ref.message?.threadId === "string") changed.add(ref.message.threadId);
          }
        }
        for (const ref of refs(entry.messagesDeleted)) {
          if (typeof ref.message?.id === "string") deleted.add(ref.message.id);
        }
      }
      return {
        changedThreadIds: [...changed],
        deletedMessageIds: [...deleted],
        historyId: body.historyId === undefined ? startHistoryId : String(body.historyId),
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
      };
    },
  };
}
```

Append to `packages/mail/src/index.ts`: `export * from "./gmail-api";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/mail test && pnpm --filter @replywise/mail typecheck && pnpm format && pnpm lint`
Expected: 44 tests PASS (39 + 5); no-send guard passes and now also scans `packages/mailbox/src` and `apps/worker/src`; typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mail): add read-only Gmail API client; widen no-send guard"
```

---

### Task 4: `@replywise/db` — sync lease column, sync writes and thread reads

**Files:**
- Modify: `packages/db/src/schema/mail.ts`, `packages/db/src/index.ts`
- Create (generated): `packages/db/migrations/0001_sync_lease.sql` + `meta/`
- Create: `packages/db/src/queries/{sync,threads}.ts`
- Test: `packages/db/src/queries/{sync,threads}.int.test.ts`

**Interfaces:**
- Consumes: existing schema (`mailAccounts`, `threads`, `messages`, `userPreferences`), `DbExecutor`, test helpers (`insertUser`, `insertMailAccount`, `insertThread`, `insertMessage`).
- Produces (`sync.ts`): `acquireSyncLease(db, mailAccountId, now: Date, leaseMs: number): Promise<boolean>`; `releaseSyncLease(db, mailAccountId): Promise<void>`; `listSyncableMailAccounts(db): Promise<Array<{ id: string; provider: MailProviderId }>>` (status `active`); `interface ThreadWrite { providerThreadId; subject; snippet; participants: EmailAddress[]; lastMessageAt: Date; messageCount: number; isUnread: boolean; providerLabels: string[] }`; `upsertThread(db, mailAccountId, t: ThreadWrite): Promise<string>`; `interface MessageWrite { providerMessageId; internetMessageId: string | null; fromAddress: EmailAddress; toAddresses; ccAddresses; subject; snippet; sentAt: Date; isFromUser: boolean; hasAttachments: boolean }`; `upsertMessage(db, threadId, mailAccountId, m: MessageWrite): Promise<string>`; `setMessageBody(db, messageId, ciphertext: Buffer, expiresAt: Date): Promise<void>`; `deleteMessagesNotIn(db, threadId, keep: string[]): Promise<number>`; `deleteThreadsByProviderIds(db, mailAccountId, ids: string[]): Promise<number>`; `deleteMessagesByProviderIds(db, mailAccountId, ids: string[]): Promise<number>`; `recordSyncSuccess(db, mailAccountId, cursor: string, now: Date): Promise<void>`; `recordSyncFailure(db, mailAccountId, message: string): Promise<void>`; `getBodyCacheDays(db, userId): Promise<number>` (default 14).
- Produces (`threads.ts`): `interface InboxThread { id; subject; snippet; participants: EmailAddress[]; lastMessageAt: Date; messageCount: number; isUnread: boolean; mailAccountId: string; mailboxEmail: string }`; `listInboxThreads(db, userId, limit?: number): Promise<InboxThread[]>` (threads labelled `INBOX`, newest first, default 50); `interface ThreadDetail { thread: { id; subject; providerThreadId; lastMessageAt: Date }; mailbox: { id; provider: MailProviderId; emailAddress; status }; messages: Array<typeof messages.$inferSelect> }`; `getThreadForUser(db, userId, threadId): Promise<ThreadDetail | null>` (messages oldest first).

- [ ] **Step 1: Schema change and migration**

In `packages/db/src/schema/mail.ts`, add to `mailAccounts` after `lastError`:
```ts
    /** Set while a sync job holds this mailbox; expired leases may be taken over. */
    syncLeaseUntil: timestamp("sync_lease_until", { withTimezone: true }),
```
Run: `pnpm db:generate --name sync_lease`
Expected: `packages/db/migrations/0001_sync_lease.sql` containing `ALTER TABLE "mail_accounts" ADD COLUMN "sync_lease_until" timestamp with time zone;`.

- [ ] **Step 2: Write the failing integration tests**

`packages/db/src/queries/sync.int.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { mailAccounts, messages, threads, userPreferences } from "../schema/index";
import { insertMailAccount, insertUser, resetTestDb, setupTestDb } from "../testing";
import {
  acquireSyncLease,
  deleteMessagesByProviderIds,
  deleteMessagesNotIn,
  deleteThreadsByProviderIds,
  getBodyCacheDays,
  listSyncableMailAccounts,
  type MessageWrite,
  recordSyncFailure,
  recordSyncSuccess,
  releaseSyncLease,
  setMessageBody,
  type ThreadWrite,
  upsertMessage,
  upsertThread,
} from "./sync";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

const T0 = new Date("2026-11-17T12:00:00Z");
const thread = (overrides: Partial<ThreadWrite> = {}): ThreadWrite => ({
  providerThreadId: "t1",
  subject: "Hello",
  snippet: "First",
  participants: [{ name: "Ada", address: "ada@x.com" }],
  lastMessageAt: T0,
  messageCount: 1,
  isUnread: true,
  providerLabels: ["INBOX", "UNREAD"],
  ...overrides,
});
const message = (overrides: Partial<MessageWrite> = {}): MessageWrite => ({
  providerMessageId: "m1",
  internetMessageId: "<m1@x.com>",
  fromAddress: { name: "Ada", address: "ada@x.com" },
  toAddresses: [{ name: null, address: "me@gmail.com" }],
  ccAddresses: [],
  subject: "Hello",
  snippet: "First",
  sentAt: T0,
  isFromUser: false,
  hasAttachments: false,
  ...overrides,
});

describe("sync lease", () => {
  it("is exclusive until released or expired, and never granted to needs_reauth mailboxes", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    expect(await acquireSyncLease(db, account.id, T0, 600_000)).toBe(true);
    expect(await acquireSyncLease(db, account.id, T0, 600_000)).toBe(false);
    expect(await acquireSyncLease(db, account.id, new Date(T0.getTime() + 600_001), 600_000)).toBe(true);
    await releaseSyncLease(db, account.id);
    expect(await acquireSyncLease(db, account.id, T0, 600_000)).toBe(true);

    const reauth = await insertMailAccount(db, user.id, { status: "needs_reauth" });
    expect(await acquireSyncLease(db, reauth.id, T0, 600_000)).toBe(false);
  });

  it("lists only active mailboxes as syncable", async () => {
    const user = await insertUser(db);
    const active = await insertMailAccount(db, user.id);
    await insertMailAccount(db, user.id, { status: "needs_reauth" });
    expect(await listSyncableMailAccounts(db)).toEqual([{ id: active.id, provider: "gmail" }]);
  });
});

describe("thread and message upserts", () => {
  it("are idempotent and update fields in place", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const id1 = await upsertThread(db, account.id, thread());
    const id2 = await upsertThread(db, account.id, thread({ snippet: "Second", messageCount: 2 }));
    expect(id2).toBe(id1);
    const [row] = await db.select().from(threads).where(eq(threads.id, id1));
    expect(row).toMatchObject({ snippet: "Second", messageCount: 2, isUnread: true });

    const m1 = await upsertMessage(db, id1, account.id, message());
    const m1again = await upsertMessage(db, id1, account.id, message({ snippet: "Edited" }));
    expect(m1again).toBe(m1);
    await upsertMessage(db, id1, account.id, message({ providerMessageId: "m2" }));
    expect(await deleteMessagesNotIn(db, id1, ["m2"])).toBe(1);
    expect((await db.select().from(messages)).map((m) => m.providerMessageId)).toEqual(["m2"]);
  });

  it("stores bodies and deletes by provider ids", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    const threadId = await upsertThread(db, account.id, thread());
    const messageId = await upsertMessage(db, threadId, account.id, message());
    const expires = new Date(T0.getTime() + 86_400_000);
    await setMessageBody(db, messageId, Buffer.from([1, 2, 3]), expires);
    const [stored] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(stored?.bodyCiphertext?.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(stored?.bodyExpiresAt?.getTime()).toBe(expires.getTime());

    expect(await deleteMessagesByProviderIds(db, account.id, ["m1", "unknown"])).toBe(1);
    expect(await deleteThreadsByProviderIds(db, account.id, ["t1"])).toBe(1);
    expect(await db.select().from(threads)).toHaveLength(0);
    expect(await deleteThreadsByProviderIds(db, account.id, [])).toBe(0);
  });
});

describe("sync bookkeeping", () => {
  it("records success and failure without touching status", async () => {
    const user = await insertUser(db);
    const account = await insertMailAccount(db, user.id);
    await recordSyncFailure(db, account.id, "Gmail API request failed (500)");
    let [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row).toMatchObject({ status: "active", lastError: "Gmail API request failed (500)" });
    await recordSyncSuccess(db, account.id, "777", T0);
    [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row).toMatchObject({ syncCursor: "777", lastError: null, status: "active" });
    expect(row?.lastSyncedAt?.getTime()).toBe(T0.getTime());
  });

  it("reads the body cache retention preference with a 14-day default", async () => {
    const user = await insertUser(db);
    expect(await getBodyCacheDays(db, user.id)).toBe(14);
    await db.insert(userPreferences).values({ userId: user.id, bodyCacheDays: 3 });
    expect(await getBodyCacheDays(db, user.id)).toBe(3);
  });
});
```

`packages/db/src/queries/threads.int.test.ts`:
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
import { getThreadForUser, listInboxThreads } from "./threads";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

describe("listInboxThreads", () => {
  it("returns only the user's INBOX threads, newest first, with the mailbox address", async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const mailbox = await insertMailAccount(db, alice.id, { emailAddress: "alice@gmail.com" });
    const other = await insertMailAccount(db, bob.id);
    await insertThread(db, mailbox.id, {
      providerThreadId: "old",
      subject: "Older",
      providerLabels: ["INBOX"],
      lastMessageAt: new Date("2026-11-01T00:00:00Z"),
    });
    await insertThread(db, mailbox.id, {
      providerThreadId: "new",
      subject: "Newer",
      providerLabels: ["INBOX", "UNREAD"],
      isUnread: true,
      lastMessageAt: new Date("2026-11-10T00:00:00Z"),
    });
    await insertThread(db, mailbox.id, { providerThreadId: "sent", providerLabels: ["SENT"] });
    await insertThread(db, other.id, { providerThreadId: "bob", providerLabels: ["INBOX"] });

    const list = await listInboxThreads(db, alice.id);
    expect(list.map((t) => t.subject)).toEqual(["Newer", "Older"]);
    expect(list[0]).toMatchObject({ isUnread: true, mailboxEmail: "alice@gmail.com" });
    expect(await listInboxThreads(db, alice.id, 1)).toHaveLength(1);
  });
});

describe("getThreadForUser", () => {
  it("returns the thread with messages oldest first, and nothing for other users", async () => {
    const alice = await insertUser(db);
    const mallory = await insertUser(db);
    const mailbox = await insertMailAccount(db, alice.id);
    const thread = await insertThread(db, mailbox.id, { subject: "Plans" });
    await insertMessage(db, thread.id, mailbox.id, {
      providerMessageId: "b",
      sentAt: new Date("2026-11-02T00:00:00Z"),
    });
    await insertMessage(db, thread.id, mailbox.id, {
      providerMessageId: "a",
      sentAt: new Date("2026-11-01T00:00:00Z"),
    });

    const detail = await getThreadForUser(db, alice.id, thread.id);
    expect(detail?.thread.subject).toBe("Plans");
    expect(detail?.mailbox).toMatchObject({ id: mailbox.id, provider: "gmail", status: "active" });
    expect(detail?.messages.map((m) => m.providerMessageId)).toEqual(["a", "b"]);
    expect(await getThreadForUser(db, mallory.id, thread.id)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @replywise/db test:int`
Expected: FAIL — cannot resolve `./sync` / `./threads`.

- [ ] **Step 4: Implement**

`packages/db/src/queries/sync.ts`:
```ts
import type { EmailAddress, MailProviderId } from "@replywise/core";
import { and, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { userPreferences } from "../schema/ai";
import { mailAccounts, messages, threads } from "../schema/mail";

export async function acquireSyncLease(
  db: DbExecutor,
  mailAccountId: string,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const rows = await db
    .update(mailAccounts)
    .set({ syncLeaseUntil: new Date(now.getTime() + leaseMs) })
    .where(
      and(
        eq(mailAccounts.id, mailAccountId),
        eq(mailAccounts.status, "active"),
        or(isNull(mailAccounts.syncLeaseUntil), lte(mailAccounts.syncLeaseUntil, now)),
      ),
    )
    .returning({ id: mailAccounts.id });
  return rows.length > 0;
}

export async function releaseSyncLease(db: DbExecutor, mailAccountId: string): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ syncLeaseUntil: null })
    .where(eq(mailAccounts.id, mailAccountId));
}

export async function listSyncableMailAccounts(
  db: DbExecutor,
): Promise<Array<{ id: string; provider: MailProviderId }>> {
  return db
    .select({ id: mailAccounts.id, provider: mailAccounts.provider })
    .from(mailAccounts)
    .where(eq(mailAccounts.status, "active"));
}

export interface ThreadWrite {
  providerThreadId: string;
  subject: string;
  snippet: string;
  participants: EmailAddress[];
  lastMessageAt: Date;
  messageCount: number;
  isUnread: boolean;
  providerLabels: string[];
}

export async function upsertThread(
  db: DbExecutor,
  mailAccountId: string,
  t: ThreadWrite,
): Promise<string> {
  const values = {
    subject: t.subject,
    snippet: t.snippet,
    participants: t.participants,
    lastMessageAt: t.lastMessageAt,
    messageCount: t.messageCount,
    isUnread: t.isUnread,
    providerLabels: t.providerLabels,
  };
  const [row] = await db
    .insert(threads)
    .values({ mailAccountId, providerThreadId: t.providerThreadId, ...values })
    .onConflictDoUpdate({ target: [threads.mailAccountId, threads.providerThreadId], set: values })
    .returning({ id: threads.id });
  if (!row) throw new Error("upsertThread returned no row");
  return row.id;
}

export interface MessageWrite {
  providerMessageId: string;
  internetMessageId: string | null;
  fromAddress: EmailAddress;
  toAddresses: EmailAddress[];
  ccAddresses: EmailAddress[];
  subject: string;
  snippet: string;
  sentAt: Date;
  isFromUser: boolean;
  hasAttachments: boolean;
}

export async function upsertMessage(
  db: DbExecutor,
  threadId: string,
  mailAccountId: string,
  m: MessageWrite,
): Promise<string> {
  const { providerMessageId, ...values } = m;
  const [row] = await db
    .insert(messages)
    .values({ threadId, mailAccountId, providerMessageId, ...values })
    .onConflictDoUpdate({
      target: [messages.mailAccountId, messages.providerMessageId],
      set: { threadId, ...values },
    })
    .returning({ id: messages.id });
  if (!row) throw new Error("upsertMessage returned no row");
  return row.id;
}

export async function setMessageBody(
  db: DbExecutor,
  messageId: string,
  ciphertext: Buffer,
  expiresAt: Date,
): Promise<void> {
  await db
    .update(messages)
    .set({ bodyCiphertext: ciphertext, bodyExpiresAt: expiresAt })
    .where(eq(messages.id, messageId));
}

export async function deleteMessagesNotIn(
  db: DbExecutor,
  threadId: string,
  keepProviderMessageIds: string[],
): Promise<number> {
  const deleted = await db
    .delete(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        notInArray(messages.providerMessageId, keepProviderMessageIds),
      ),
    )
    .returning({ id: messages.id });
  return deleted.length;
}

export async function deleteThreadsByProviderIds(
  db: DbExecutor,
  mailAccountId: string,
  providerThreadIds: string[],
): Promise<number> {
  if (providerThreadIds.length === 0) return 0;
  const deleted = await db
    .delete(threads)
    .where(
      and(
        eq(threads.mailAccountId, mailAccountId),
        inArray(threads.providerThreadId, providerThreadIds),
      ),
    )
    .returning({ id: threads.id });
  return deleted.length;
}

export async function deleteMessagesByProviderIds(
  db: DbExecutor,
  mailAccountId: string,
  providerMessageIds: string[],
): Promise<number> {
  if (providerMessageIds.length === 0) return 0;
  const deleted = await db
    .delete(messages)
    .where(
      and(
        eq(messages.mailAccountId, mailAccountId),
        inArray(messages.providerMessageId, providerMessageIds),
      ),
    )
    .returning({ id: messages.id });
  return deleted.length;
}

export async function recordSyncSuccess(
  db: DbExecutor,
  mailAccountId: string,
  cursor: string,
  now: Date,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ syncCursor: cursor, lastSyncedAt: now, lastError: null })
    .where(eq(mailAccounts.id, mailAccountId));
}

/** `message` must be a fixed, non-secret string (see sync's describeSyncError). */
export async function recordSyncFailure(
  db: DbExecutor,
  mailAccountId: string,
  message: string,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ lastError: message })
    .where(eq(mailAccounts.id, mailAccountId));
}

export const DEFAULT_BODY_CACHE_DAYS = 14;

export async function getBodyCacheDays(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ days: userPreferences.bodyCacheDays })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return row?.days ?? DEFAULT_BODY_CACHE_DAYS;
}
```

`packages/db/src/queries/threads.ts`:
```ts
import type { EmailAddress, MailProviderId } from "@replywise/core";
import { and, arrayContains, asc, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "../client";
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
}

export async function listInboxThreads(
  db: DbExecutor,
  userId: string,
  limit = 50,
): Promise<InboxThread[]> {
  return db
    .select({
      id: threads.id,
      subject: threads.subject,
      snippet: threads.snippet,
      participants: threads.participants,
      lastMessageAt: threads.lastMessageAt,
      messageCount: threads.messageCount,
      isUnread: threads.isUnread,
      mailAccountId: threads.mailAccountId,
      mailboxEmail: mailAccounts.emailAddress,
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(and(eq(mailAccounts.userId, userId), arrayContains(threads.providerLabels, ["INBOX"])))
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
}

export interface ThreadDetail {
  thread: { id: string; subject: string; providerThreadId: string; lastMessageAt: Date };
  mailbox: {
    id: string;
    provider: MailProviderId;
    emailAddress: string;
    status: "active" | "needs_reauth" | "error";
  };
  messages: Array<typeof messages.$inferSelect>;
}

export async function getThreadForUser(
  db: DbExecutor,
  userId: string,
  threadId: string,
): Promise<ThreadDetail | null> {
  const [row] = await db
    .select({
      thread: {
        id: threads.id,
        subject: threads.subject,
        providerThreadId: threads.providerThreadId,
        lastMessageAt: threads.lastMessageAt,
      },
      mailbox: {
        id: mailAccounts.id,
        provider: mailAccounts.provider,
        emailAddress: mailAccounts.emailAddress,
        status: mailAccounts.status,
      },
    })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(and(eq(threads.id, threadId), eq(mailAccounts.userId, userId)));
  if (!row) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.sentAt));
  return { ...row, messages: rows };
}
```

Add to `packages/db/src/index.ts` (keep the existing lines and the trailing migrate comment):
```ts
export * from "./queries/sync";
export * from "./queries/threads";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/db test:int && pnpm --filter @replywise/db typecheck && pnpm typecheck && pnpm format && pnpm lint`
Expected: 20 integration tests PASS (12 existing + 6 in sync.int.test.ts + 2 in threads.int.test.ts); `setupTestDb()` applies migration 0001; typecheck and lint exit 0.

- [ ] **Step 6: Migrate the dev database and commit**

Run: `pnpm db:migrate` (expected: `migrations applied`), then:
```bash
git add -A
git commit -m "feat(db): add sync lease, sync write queries and owner-scoped thread reads"
```

---

### Task 5: `@replywise/sync` — the Gmail sync engine

**Files:**
- Create: `packages/sync/{package.json,tsconfig.json,vitest.config.ts,vitest.int.config.ts}`
- Create: `packages/sync/src/{index,deps,errors,concurrency,body-codec,thread-summary,persist,sync-mailbox,testing}.ts`
- Test: `packages/sync/src/{concurrency,thread-summary}.test.ts`, `packages/sync/src/sync-mailbox.int.test.ts`

**Interfaces:**
- Consumes: `MailboxDeps`, `clock`, `getValidAccessToken`, `ReauthRequiredError` (mailbox); `GmailApi`, `GmailApiFactory`, `HistoryExpiredError`, `ParsedThread`, `ParsedMessage`, `ProviderHttpError`, `OAuthError` (mail); Task 4 queries; `aad`, `Encryptor` (crypto); `createFakeProvider`, `testEncryptor` (`@replywise/mailbox/testing`).
- Produces: `interface SyncDeps extends MailboxDeps { gmail: GmailApiFactory; maxBackfillThreads?: number }`; `SYNC_LEASE_MS = 600_000`; `BACKFILL_QUERY = "in:inbox newer_than:30d"`; `MAX_BACKFILL_THREADS = 300`; `type SyncOutcome = { status: "synced"; mode: "backfill" | "incremental"; threads: number } | { status: "skipped"; reason: "not_found" | "unsupported_provider" | "needs_reauth" | "locked" }`; `syncMailbox(deps: SyncDeps, mailAccountId: string): Promise<SyncOutcome>`; `describeSyncError(error: unknown): string`; `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>`; `summarizeThread(thread: ParsedThread): ThreadWrite`; `encryptBody(encryptor, messageId, body: { text: string | null; html: string | null }): Promise<Buffer>`; `decryptBody(encryptor, messageId, blob: Buffer): Promise<{ text: string | null; html: string | null }>`; `persistThreads(tx: DbExecutor, encryptor: Encryptor, account: { id: string; userId: string; emailAddress: string }, threads: ParsedThread[], now: Date): Promise<void>`; from `@replywise/sync/testing`: `createFakeGmail(seed?)`, `fakeMessage(overrides)`.

- [ ] **Step 1: Create the package**

`packages/sync/package.json`:
```json
{
  "name": "@replywise/sync",
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
Copy `tsconfig.json`, `vitest.config.ts`, `vitest.int.config.ts` from `packages/mailbox/`. Then:
```bash
pnpm --filter @replywise/sync add "@replywise/core@workspace:*" "@replywise/crypto@workspace:*" "@replywise/db@workspace:*" "@replywise/mail@workspace:*" "@replywise/mailbox@workspace:*" drizzle-orm
pnpm --filter @replywise/sync add -D vitest typescript @types/node
```

- [ ] **Step 2: Write the failing tests**

`packages/sync/src/concurrency.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("preserves order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n * 5));
      active--;
      return n * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("rejects when any call rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
```

`packages/sync/src/thread-summary.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fakeMessage } from "./testing";
import { summarizeThread } from "./thread-summary";

describe("summarizeThread", () => {
  it("summarises subject, snippet, participants, unread and labels", () => {
    const summary = summarizeThread({
      providerThreadId: "t1",
      messages: [
        fakeMessage({
          providerMessageId: "m2",
          sentAt: new Date("2026-11-02T00:00:00Z"),
          subject: "Re: Plans",
          snippet: "Sounds good",
          from: { name: "Me", address: "me@gmail.com" },
          to: [{ name: "Ada", address: "ada@x.com" }],
          labelIds: ["SENT"],
        }),
        fakeMessage({
          providerMessageId: "m1",
          sentAt: new Date("2026-11-01T00:00:00Z"),
          subject: "Plans",
          snippet: "Shall we?",
          from: { name: "Ada", address: "ada@x.com" },
          to: [{ name: null, address: "me@gmail.com" }],
          cc: [{ name: "Bob", address: "bob@y.com" }],
          labelIds: ["INBOX", "UNREAD"],
        }),
      ],
    });
    expect(summary).toEqual({
      providerThreadId: "t1",
      subject: "Plans",
      snippet: "Sounds good",
      participants: [
        { name: "Ada", address: "ada@x.com" },
        { name: null, address: "me@gmail.com" },
        { name: "Bob", address: "bob@y.com" },
      ],
      lastMessageAt: new Date("2026-11-02T00:00:00Z"),
      messageCount: 2,
      isUnread: true,
      providerLabels: ["INBOX", "SENT", "UNREAD"],
    });
  });
});
```

`packages/sync/src/sync-mailbox.int.test.ts`:
```ts
import { aad } from "@replywise/crypto";
import { type Db, mailAccounts, messages, threads, userPreferences } from "@replywise/db";
import { insertMailAccount, insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { ProviderHttpError } from "@replywise/mail";
import { completeConnect, startConnect } from "@replywise/mailbox";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptBody } from "./body-codec";
import type { SyncDeps } from "./deps";
import { syncMailbox } from "./sync-mailbox";
import { createFakeGmail, fakeMessage } from "./testing";

const T0 = new Date("2026-11-17T12:00:00Z");
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function connectedGmail(email = "me@gmail.com") {
  const provider = createFakeProvider("gmail", { email });
  const encryptor = testEncryptor();
  const base = { db, encryptor, providers: { gmail: provider.provider }, now: () => T0 };
  const user = await insertUser(db);
  const url = await startConnect(base, { userId: user.id, provider: "gmail", redirectUri: "http://cb" });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(base, {
    userId: user.id, provider: "gmail", code: "c", state, redirectUri: "http://cb",
  });
  return { base, userId: user.id, mailAccountId, encryptor };
}

function syncDeps(base: Omit<SyncDeps, "gmail">, gmail: ReturnType<typeof createFakeGmail>): SyncDeps {
  return { ...base, gmail: gmail.factory };
}

describe("syncMailbox — backfill", () => {
  it("stores inbox threads, messages and encrypted bodies, then saves the history cursor", async () => {
    const { base, userId, mailAccountId, encryptor } = await connectedGmail();
    await db.insert(userPreferences).values({ userId, bodyCacheDays: 3 });
    const gmail = createFakeGmail({
      historyId: "500",
      threads: {
        t1: [
          fakeMessage({
            providerMessageId: "m1",
            providerThreadId: "t1",
            from: { name: "Ada", address: "ada@x.com" },
            bodyHtml: "<p>Hi</p>",
            bodyText: "Hi",
            labelIds: ["INBOX", "UNREAD"],
          }),
          fakeMessage({
            providerMessageId: "m2",
            providerThreadId: "t1",
            from: { name: "Me", address: "me@gmail.com" },
            sentAt: new Date("2026-11-16T00:00:00Z"),
            labelIds: ["SENT"],
          }),
        ],
      },
    });

    const outcome = await syncMailbox(syncDeps(base, gmail), mailAccountId);

    expect(outcome).toEqual({ status: "synced", mode: "backfill", threads: 1 });
    expect(gmail.calls.listThreadIds[0]?.query).toBe("in:inbox newer_than:30d");
    const [thread] = await db.select().from(threads);
    expect(thread).toMatchObject({ providerThreadId: "t1", messageCount: 2, isUnread: true });
    const rows = await db.select().from(messages).orderBy(messages.sentAt);
    expect(rows.map((m) => [m.providerMessageId, m.isFromUser])).toEqual([
      ["m1", false],
      ["m2", true],
    ]);
    const first = rows[0];
    if (!first?.bodyCiphertext) throw new Error("body not stored");
    expect(first.bodyCiphertext.includes(Buffer.from("<p>Hi</p>"))).toBe(false);
    expect(await decryptBody(encryptor, first.id, first.bodyCiphertext)).toEqual({
      text: "Hi",
      html: "<p>Hi</p>",
    });
    expect(first.bodyExpiresAt?.getTime()).toBe(T0.getTime() + 3 * 86_400_000);
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
    expect(account).toMatchObject({ syncCursor: "500", lastError: null, syncLeaseUntil: null });
    expect(account?.lastSyncedAt?.getTime()).toBe(T0.getTime());
  });

  it("stops at the backfill cap", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const seeded: Record<string, ReturnType<typeof fakeMessage>[]> = {};
    for (let i = 0; i < 5; i++) {
      seeded[`t${i}`] = [fakeMessage({ providerMessageId: `m${i}`, providerThreadId: `t${i}` })];
    }
    const gmail = createFakeGmail({ threads: seeded, pageSize: 2 });
    const outcome = await syncMailbox({ ...syncDeps(base, gmail), maxBackfillThreads: 3 }, mailAccountId);
    expect(outcome).toMatchObject({ status: "synced", threads: 3 });
    expect(await db.select().from(threads)).toHaveLength(3);
  });
});

describe("syncMailbox — incremental", () => {
  it("applies changed threads, deleted messages and vanished threads, then advances the cursor", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail({
      historyId: "100",
      threads: {
        t1: [fakeMessage({ providerMessageId: "m1", providerThreadId: "t1" })],
        t2: [fakeMessage({ providerMessageId: "m2", providerThreadId: "t2" })],
      },
    });
    const deps = syncDeps(base, gmail);
    await syncMailbox(deps, mailAccountId);

    gmail.threads.t1?.push(fakeMessage({ providerMessageId: "m3", providerThreadId: "t1" }));
    delete gmail.threads.t2;
    gmail.history.push({
      changedThreadIds: ["t1", "t2"],
      deletedMessageIds: ["m2"],
      historyId: "180",
      nextPageToken: null,
    });

    expect(await syncMailbox(deps, mailAccountId)).toEqual({
      status: "synced",
      mode: "incremental",
      threads: 1,
    });
    expect(gmail.calls.listHistory[0]?.startHistoryId).toBe("100");
    expect((await db.select().from(threads)).map((t) => t.providerThreadId)).toEqual(["t1"]);
    expect((await db.select().from(messages)).map((m) => m.providerMessageId).sort()).toEqual([
      "m1",
      "m3",
    ]);
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
    expect(account?.syncCursor).toBe("180");
  });

  it("falls back to a backfill when the history id has expired", async () => {
    const { base, mailAccountId } = await connectedGmail();
    await db.update(mailAccounts).set({ syncCursor: "1" }).where(eq(mailAccounts.id, mailAccountId));
    const gmail = createFakeGmail({
      historyId: "900",
      historyExpired: true,
      threads: { t1: [fakeMessage({ providerThreadId: "t1" })] },
    });
    expect(await syncMailbox(syncDeps(base, gmail), mailAccountId)).toMatchObject({
      status: "synced",
      mode: "backfill",
    });
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
    expect(account?.syncCursor).toBe("900");
  });
});

describe("syncMailbox — guards and failures", () => {
  it("skips mailboxes that are locked, unsupported, needing reauth, or gone", async () => {
    const { base, userId, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail();
    const deps = syncDeps(base, gmail);
    await db
      .update(mailAccounts)
      .set({ syncLeaseUntil: new Date(T0.getTime() + 60_000) })
      .where(eq(mailAccounts.id, mailAccountId));
    expect(await syncMailbox(deps, mailAccountId)).toEqual({ status: "skipped", reason: "locked" });

    const outlook = await insertMailAccount(db, userId, { provider: "outlook" });
    expect(await syncMailbox(deps, outlook.id)).toEqual({
      status: "skipped",
      reason: "unsupported_provider",
    });
    const reauth = await insertMailAccount(db, userId, { status: "needs_reauth" });
    expect(await syncMailbox(deps, reauth.id)).toEqual({ status: "skipped", reason: "needs_reauth" });
    expect(await syncMailbox(deps, "00000000-0000-4000-8000-000000000000")).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    expect(gmail.calls.factory).toBe(0);
  });

  it("records a non-secret error, keeps the old cursor, releases the lease and rethrows", async () => {
    const { base, mailAccountId } = await connectedGmail();
    const gmail = createFakeGmail({ failWith: new ProviderHttpError(500, "/gmail/v1/users/me/threads") });
    const deps = syncDeps(base, gmail);
    await expect(syncMailbox(deps, mailAccountId)).rejects.toBeInstanceOf(ProviderHttpError);
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
    expect(account).toMatchObject({
      lastError: "Gmail API request failed (500)",
      syncCursor: null,
      syncLeaseUntil: null,
      status: "active",
    });
    expect(await db.select().from(threads)).toHaveLength(0);
  });

  it("uses the message body AAD so a body cannot be decrypted as another message", async () => {
    const { base, mailAccountId, encryptor } = await connectedGmail();
    const gmail = createFakeGmail({
      threads: {
        t1: [
          fakeMessage({ providerMessageId: "a", providerThreadId: "t1", bodyText: "secret" }),
          fakeMessage({ providerMessageId: "b", providerThreadId: "t1", bodyText: "other" }),
        ],
      },
    });
    await syncMailbox(syncDeps(base, gmail), mailAccountId);
    const [a, b] = await db.select().from(messages).orderBy(messages.providerMessageId);
    if (!a?.bodyCiphertext || !b) throw new Error("missing rows");
    await expect(
      encryptor.decrypt(a.bodyCiphertext, aad.messageBody(b.id)),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @replywise/sync test; pnpm --filter @replywise/sync test:int`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`packages/sync/src/deps.ts`:
```ts
import type { GmailApiFactory } from "@replywise/mail";
import type { MailboxDeps } from "@replywise/mailbox";

export interface SyncDeps extends MailboxDeps {
  /** Builds a Gmail client for an access token (injectable for tests). */
  gmail: GmailApiFactory;
  /** Overrides MAX_BACKFILL_THREADS (tests). */
  maxBackfillThreads?: number;
}
```

`packages/sync/src/concurrency.ts`:
```ts
/** Runs fn over items with at most `limit` calls in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
```

`packages/sync/src/errors.ts`:
```ts
import { OAuthError, ProviderHttpError } from "@replywise/mail";

/** Fixed, non-secret text for mail_accounts.last_error. Never includes provider messages. */
export function describeSyncError(error: unknown): string {
  if (error instanceof ProviderHttpError) {
    return error.status === 0 ? "Gmail API timed out" : `Gmail API request failed (${error.status})`;
  }
  if (error instanceof OAuthError) return `Token refresh failed (${error.code})`;
  return "Sync failed unexpectedly";
}
```

`packages/sync/src/body-codec.ts`:
```ts
import { aad, type Encryptor } from "@replywise/crypto";

export interface MessageBody {
  text: string | null;
  html: string | null;
}

export function encryptBody(encryptor: Encryptor, messageId: string, body: MessageBody): Promise<Buffer> {
  return encryptor.encrypt(JSON.stringify(body), aad.messageBody(messageId));
}

export async function decryptBody(
  encryptor: Encryptor,
  messageId: string,
  blob: Buffer,
): Promise<MessageBody> {
  const parsed = JSON.parse(await encryptor.decryptString(blob, aad.messageBody(messageId))) as {
    text?: unknown;
    html?: unknown;
  };
  return {
    text: typeof parsed.text === "string" ? parsed.text : null,
    html: typeof parsed.html === "string" ? parsed.html : null,
  };
}
```

`packages/sync/src/thread-summary.ts`:
```ts
import type { EmailAddress } from "@replywise/core";
import type { ThreadWrite } from "@replywise/db";
import type { ParsedThread } from "@replywise/mail";

/** Thread-level fields derived from its messages. The thread must have at least one message. */
export function summarizeThread(thread: ParsedThread): ThreadWrite {
  const sorted = [...thread.messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) throw new Error("summarizeThread needs at least one message");

  const participants: EmailAddress[] = [];
  const seen = new Set<string>();
  for (const message of sorted) {
    for (const address of [message.from, ...message.to, ...message.cc]) {
      if (address.address === "" || seen.has(address.address)) continue;
      seen.add(address.address);
      participants.push(address);
    }
  }
  const labels = new Set(sorted.flatMap((m) => m.labelIds));
  return {
    providerThreadId: thread.providerThreadId,
    subject: first.subject,
    snippet: last.snippet,
    participants,
    lastMessageAt: last.sentAt,
    messageCount: sorted.length,
    isUnread: labels.has("UNREAD"),
    providerLabels: [...labels].sort(),
  };
}
```

`packages/sync/src/persist.ts`:
```ts
import type { Encryptor } from "@replywise/crypto";
import {
  type DbExecutor,
  deleteMessagesNotIn,
  deleteThreadsByProviderIds,
  getBodyCacheDays,
  setMessageBody,
  upsertMessage,
  upsertThread,
} from "@replywise/db";
import type { ParsedThread } from "@replywise/mail";
import { encryptBody } from "./body-codec";
import { summarizeThread } from "./thread-summary";

const DAY_MS = 86_400_000;

export interface PersistAccount {
  id: string;
  userId: string;
  emailAddress: string;
}

/** Writes parsed threads (inside the caller's transaction). Threads without messages are deleted. */
export async function persistThreads(
  tx: DbExecutor,
  encryptor: Encryptor,
  account: PersistAccount,
  parsed: ParsedThread[],
  now: Date,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + (await getBodyCacheDays(tx, account.userId)) * DAY_MS);
  const owner = account.emailAddress.toLowerCase();

  for (const thread of parsed) {
    if (thread.messages.length === 0) {
      await deleteThreadsByProviderIds(tx, account.id, [thread.providerThreadId]);
      continue;
    }
    const threadId = await upsertThread(tx, account.id, summarizeThread(thread));
    for (const message of thread.messages) {
      const messageId = await upsertMessage(tx, threadId, account.id, {
        providerMessageId: message.providerMessageId,
        internetMessageId: message.internetMessageId,
        fromAddress: message.from,
        toAddresses: message.to,
        ccAddresses: message.cc,
        subject: message.subject,
        snippet: message.snippet,
        sentAt: message.sentAt,
        isFromUser: message.from.address === owner,
        hasAttachments: message.hasAttachments,
      });
      if (message.bodyText !== null || message.bodyHtml !== null) {
        const blob = await encryptBody(encryptor, messageId, {
          text: message.bodyText,
          html: message.bodyHtml,
        });
        await setMessageBody(tx, messageId, blob, expiresAt);
      }
    }
    await deleteMessagesNotIn(
      tx,
      threadId,
      thread.messages.map((m) => m.providerMessageId),
    );
  }
}
```

`packages/sync/src/sync-mailbox.ts`:
```ts
import {
  acquireSyncLease,
  deleteMessagesByProviderIds,
  deleteThreadsByProviderIds,
  mailAccounts,
  recordSyncFailure,
  recordSyncSuccess,
  releaseSyncLease,
} from "@replywise/db";
import { type GmailApi, HistoryExpiredError, type ParsedThread } from "@replywise/mail";
import { clock, getValidAccessToken, ReauthRequiredError } from "@replywise/mailbox";
import { eq } from "drizzle-orm";
import { mapWithConcurrency } from "./concurrency";
import type { SyncDeps } from "./deps";
import { describeSyncError } from "./errors";
import { persistThreads } from "./persist";

export const SYNC_LEASE_MS = 10 * 60 * 1000;
export const BACKFILL_QUERY = "in:inbox newer_than:30d";
export const MAX_BACKFILL_THREADS = 300;
const PAGE_SIZE = 100;
const FETCH_CONCURRENCY = 5;

export type SyncOutcome =
  | { status: "synced"; mode: "backfill" | "incremental"; threads: number }
  | { status: "skipped"; reason: "not_found" | "unsupported_provider" | "needs_reauth" | "locked" };

interface Changes {
  mode: "backfill" | "incremental";
  threads: ParsedThread[];
  vanishedThreadIds: string[];
  deletedMessageIds: string[];
  cursor: string;
}

async function backfill(api: GmailApi, cap: number): Promise<Changes> {
  // Take the history id first so changes made during the backfill are replayed next time.
  const { historyId } = await api.getProfile();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api.listThreadIds({
      query: BACKFILL_QUERY,
      maxResults: Math.min(PAGE_SIZE, cap - ids.length),
      ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...page.ids.slice(0, cap - ids.length));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && ids.length < cap);
  const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, (id) => api.getThread(id));
  return {
    mode: "backfill",
    threads: fetched.filter((t): t is ParsedThread => t !== null),
    vanishedThreadIds: [],
    deletedMessageIds: [],
    cursor: historyId,
  };
}

async function incremental(api: GmailApi, startHistoryId: string): Promise<Changes> {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let cursor = startHistoryId;
  let pageToken: string | undefined;
  do {
    const page = await api.listHistory({ startHistoryId, ...(pageToken ? { pageToken } : {}) });
    for (const id of page.changedThreadIds) changed.add(id);
    for (const id of page.deletedMessageIds) deleted.add(id);
    cursor = page.historyId;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  const ids = [...changed];
  const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, (id) => api.getThread(id));
  return {
    mode: "incremental",
    threads: fetched.filter((t): t is ParsedThread => t !== null),
    vanishedThreadIds: ids.filter((_, i) => fetched[i] === null),
    deletedMessageIds: [...deleted],
    cursor,
  };
}

/** Syncs one Gmail mailbox. Safe to call concurrently: a DB lease admits one run at a time. */
export async function syncMailbox(deps: SyncDeps, mailAccountId: string): Promise<SyncOutcome> {
  const now = clock(deps);
  const [account] = await deps.db
    .select({
      id: mailAccounts.id,
      userId: mailAccounts.userId,
      provider: mailAccounts.provider,
      emailAddress: mailAccounts.emailAddress,
      status: mailAccounts.status,
      syncCursor: mailAccounts.syncCursor,
    })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, mailAccountId));
  if (!account) return { status: "skipped", reason: "not_found" };
  if (account.provider !== "gmail") return { status: "skipped", reason: "unsupported_provider" };
  if (account.status === "needs_reauth") return { status: "skipped", reason: "needs_reauth" };
  if (!(await acquireSyncLease(deps.db, account.id, now, SYNC_LEASE_MS))) {
    return { status: "skipped", reason: "locked" };
  }

  try {
    let accessToken: string;
    try {
      ({ accessToken } = await getValidAccessToken(deps, account.id));
    } catch (error) {
      if (error instanceof ReauthRequiredError) return { status: "skipped", reason: "needs_reauth" };
      throw error;
    }
    const api = deps.gmail(accessToken);
    const cap = deps.maxBackfillThreads ?? MAX_BACKFILL_THREADS;

    let changes: Changes;
    if (account.syncCursor) {
      try {
        changes = await incremental(api, account.syncCursor);
      } catch (error) {
        if (!(error instanceof HistoryExpiredError)) throw error;
        changes = await backfill(api, cap);
      }
    } else {
      changes = await backfill(api, cap);
    }

    await deps.db.transaction(async (tx) => {
      await persistThreads(tx, deps.encryptor, account, changes.threads, now);
      await deleteThreadsByProviderIds(tx, account.id, changes.vanishedThreadIds);
      await deleteMessagesByProviderIds(tx, account.id, changes.deletedMessageIds);
      await recordSyncSuccess(tx, account.id, changes.cursor, now);
    });
    return { status: "synced", mode: changes.mode, threads: changes.threads.length };
  } catch (error) {
    await recordSyncFailure(deps.db, account.id, describeSyncError(error));
    throw error;
  } finally {
    await releaseSyncLease(deps.db, account.id);
  }
}
```

`packages/sync/src/testing.ts`:
```ts
import type { GmailApi, GmailApiFactory, HistoryPage, ParsedMessage } from "@replywise/mail";
import { HistoryExpiredError } from "@replywise/mail";

let counter = 0;

export function fakeMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  counter += 1;
  return {
    providerMessageId: `msg-${counter}`,
    providerThreadId: "t1",
    internetMessageId: null,
    from: { name: "Sender", address: "sender@example.com" },
    to: [{ name: null, address: "me@gmail.com" }],
    cc: [],
    subject: "Subject",
    snippet: "Snippet",
    sentAt: new Date("2026-11-15T00:00:00Z"),
    labelIds: ["INBOX"],
    hasAttachments: false,
    bodyText: "Body",
    bodyHtml: null,
    ...overrides,
  };
}

export interface FakeGmailSeed {
  historyId?: string;
  threads?: Record<string, ParsedMessage[]>;
  pageSize?: number;
  historyExpired?: boolean;
  failWith?: Error;
}

/** In-memory Gmail double. Mutate `threads` / push to `history` between syncs. */
export function createFakeGmail(seed: FakeGmailSeed = {}) {
  const threads: Record<string, ParsedMessage[]> = { ...(seed.threads ?? {}) };
  const history: HistoryPage[] = [];
  const calls = {
    factory: 0,
    listThreadIds: [] as Array<{ query: string; maxResults: number; pageToken?: string }>,
    listHistory: [] as Array<{ startHistoryId: string; pageToken?: string }>,
    getThread: [] as string[],
  };
  const fail = () => {
    if (seed.failWith) throw seed.failWith;
  };

  const api: GmailApi = {
    async getProfile() {
      fail();
      return { emailAddress: "me@gmail.com", historyId: seed.historyId ?? "1" };
    },
    async listThreadIds(input) {
      fail();
      calls.listThreadIds.push(input);
      const ids = Object.keys(threads);
      const start = input.pageToken ? Number(input.pageToken) : 0;
      const size = Math.min(input.maxResults, seed.pageSize ?? input.maxResults);
      const end = start + size;
      return { ids: ids.slice(start, end), nextPageToken: end < ids.length ? String(end) : null };
    },
    async getThread(threadId) {
      fail();
      calls.getThread.push(threadId);
      const messages = threads[threadId];
      return messages ? { providerThreadId: threadId, messages: [...messages] } : null;
    },
    async listHistory(input) {
      fail();
      calls.listHistory.push(input);
      if (seed.historyExpired) throw new HistoryExpiredError();
      return (
        history.shift() ?? {
          changedThreadIds: [],
          deletedMessageIds: [],
          historyId: input.startHistoryId,
          nextPageToken: null,
        }
      );
    },
  };
  const factory: GmailApiFactory = () => {
    calls.factory += 1;
    return api;
  };
  return { factory, threads, history, calls };
}
```

`packages/sync/src/index.ts`:
```ts
export * from "./body-codec";
export * from "./concurrency";
export * from "./deps";
export * from "./errors";
export * from "./persist";
export * from "./sync-mailbox";
export * from "./thread-summary";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/sync test && pnpm --filter @replywise/sync test:int && pnpm --filter @replywise/sync typecheck && pnpm --filter @replywise/mail test && pnpm format && pnpm lint`
Expected: unit 3 PASS, integration 7 PASS; the mail package's no-send guard now also scans `packages/sync/src` and passes; typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sync): add Gmail sync engine with lease, backfill, history and encrypted bodies"
```

---

### Task 6: Worker — scheduled per-mailbox sync

**Files:**
- Modify: `packages/queue/src/{jobs,bullmq}.ts`, `packages/queue/src/bullmq.int.test.ts`
- Create: `apps/worker/src/deps.ts`, `apps/worker/src/jobs/{sync-mailbox,reconcile-sync-schedules}.ts`
- Modify: `apps/worker/src/main.ts`, `apps/worker/src/index.ts`, `apps/worker/src/main.int.test.ts`, `apps/worker/package.json`

**Interfaces:**
- Consumes: `syncMailbox`, `SyncDeps` (Task 5); `listSyncableMailAccounts` (Task 4); `createGmailApi`, `createMailOAuthProviders` (mail); `createEncryptor`, `LocalKeyProvider` (crypto).
- Produces: job `"mailbox.sync"` (queue `sync`, payload `{ mailAccountId: uuid }`); job `"maintenance.reconcileSyncSchedules"` (queue `maintenance`, payload `{}`); `JobQueue.removeRepeating(queue: QueueName, schedulerId: string): Promise<void>`; `JobQueue.listRepeating(queue: QueueName): Promise<string[]>`; `SYNC_INTERVAL_MS = 120_000`; `syncSchedulerId(mailAccountId) = "mailbox.sync:" + id`; `RECONCILE_SCHEDULER_ID = "maintenance.reconcileSyncSchedules:minutely"`; `startWorker(env, logger, options?: { queuePrefix?: string; gmail?: GmailApiFactory })`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/queue/src/bullmq.int.test.ts`:
```ts
  it("lists and removes job schedulers per queue", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    const id = "00000000-0000-4000-8000-000000000001";
    await queue.scheduleRepeating(`mailbox.sync:${id}`, "mailbox.sync", { mailAccountId: id }, 120_000);
    expect(await queue.listRepeating("sync")).toEqual([`mailbox.sync:${id}`]);
    await queue.removeRepeating("sync", `mailbox.sync:${id}`);
    expect(await queue.listRepeating("sync")).toEqual([]);
  });

  it("rejects a mailbox.sync payload without a uuid", async () => {
    const queue = createJobQueue(connection(), { prefix });
    closers.push(() => queue.close());
    await expect(
      queue.enqueue("mailbox.sync", { mailAccountId: "not-a-uuid" }),
    ).rejects.toThrow();
  });
```

In `apps/worker/src/main.int.test.ts` add (imports: `createFakeGmail, fakeMessage` from `@replywise/sync/testing`, `reconcileSyncSchedulesHandler` from `./jobs/reconcile-sync-schedules`, `syncMailboxHandler` from `./jobs/sync-mailbox`, `createJobQueue` from `@replywise/queue`, `testEncryptor` from `@replywise/mailbox/testing`, `threads` from `@replywise/db`, `RECONCILE_SCHEDULER_ID` from `./main`):
```ts
describe("reconcileSyncSchedulesHandler", () => {
  it("schedules active Gmail mailboxes and removes schedules for the rest", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    const active = await insertMailAccount(db, user.id);
    await insertMailAccount(db, user.id, { status: "needs_reauth" });
    await insertMailAccount(db, user.id, { provider: "outlook" });
    const connection = createRedisConnection(REDIS_URL);
    const queue = createJobQueue(connection, { prefix: `test-${randomUUID()}` });
    const stale = "00000000-0000-4000-8000-0000000000ff";
    await queue.scheduleRepeating(`mailbox.sync:${stale}`, "mailbox.sync", { mailAccountId: stale }, 120_000);
    const { logger } = silentLogger();
    try {
      await reconcileSyncSchedulesHandler({ db, queue, logger })();
      expect(await queue.listRepeating("sync")).toEqual([`mailbox.sync:${active.id}`]);
    } finally {
      await queue.close();
      await connection.quit();
    }
  });
});

describe("syncMailboxHandler", () => {
  it("syncs a mailbox and logs only the outcome", async () => {
    const { db } = handle;
    const user = await insertUser(db);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const encryptor = testEncryptor();
    const account = await insertMailAccount(db, user.id);
    const blob = await encryptor.encrypt(
      JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt }),
      aad.mailTokens(account.id),
    );
    await db.update(mailAccounts).set({ tokensCiphertext: blob }).where(eq(mailAccounts.id, account.id));
    const gmail = createFakeGmail({
      threads: { t1: [fakeMessage({ providerThreadId: "t1", bodyText: "private words" })] },
    });
    const { logger, lines } = silentLogger();

    await syncMailboxHandler({
      syncDeps: { db, encryptor, providers: {}, gmail: gmail.factory },
      logger,
    })({ mailAccountId: account.id });

    expect(await db.select().from(threads)).toHaveLength(1);
    expect(lines.join("")).toContain('"status":"synced"');
    expect(lines.join("")).not.toContain("private words");
  });
});
```
(import `aad` from `@replywise/crypto`, `mailAccounts` from `@replywise/db`). In the existing `startWorker` test, also assert `ids` contains `RECONCILE_SCHEDULER_ID`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/queue test:int; pnpm --filter @replywise/worker test:int`
Expected: FAIL — `mailbox.sync` is not a job name; `listRepeating` missing; worker job modules missing.

- [ ] **Step 3: Implement the queue changes**

In `packages/queue/src/jobs.ts`, extend `jobDefinitions`:
```ts
export const jobDefinitions = {
  "maintenance.purgeBodies": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.purgeOAuthStates": { queue: "maintenance", payload: z.object({}).strict() },
  "maintenance.reconcileSyncSchedules": { queue: "maintenance", payload: z.object({}).strict() },
  "mailbox.sync": { queue: "sync", payload: z.object({ mailAccountId: z.uuid() }).strict() },
} as const satisfies Record<string, { queue: QueueName; payload: z.ZodType }>;
```
and add to the `JobQueue` interface:
```ts
  removeRepeating(queue: QueueName, schedulerId: string): Promise<void>;
  listRepeating(queue: QueueName): Promise<string[]>;
```
In `packages/queue/src/bullmq.ts`, add to the returned object in `createJobQueue`:
```ts
    async removeRepeating(queue, schedulerId) {
      await queueFor(queue).removeJobScheduler(schedulerId);
    },
    async listRepeating(queue) {
      const schedulers = await queueFor(queue).getJobSchedulers();
      return schedulers.map((s) => s.key).filter((key): key is string => typeof key === "string");
    },
```

- [ ] **Step 4: Implement the worker jobs and wiring**

Add dependencies:
```bash
pnpm --filter @replywise/worker add "@replywise/crypto@workspace:*" "@replywise/mail@workspace:*" "@replywise/mailbox@workspace:*" "@replywise/sync@workspace:*"
```

`apps/worker/src/jobs/sync-mailbox.ts`:
```ts
import type { Logger } from "@replywise/observability";
import { type SyncDeps, syncMailbox } from "@replywise/sync";

export function syncMailboxHandler(deps: { syncDeps: SyncDeps; logger: Logger }) {
  return async ({ mailAccountId }: { mailAccountId: string }): Promise<void> => {
    const outcome = await syncMailbox(deps.syncDeps, mailAccountId);
    deps.logger.info({ mailAccountId, ...outcome }, "mailbox sync");
  };
}
```

`apps/worker/src/jobs/reconcile-sync-schedules.ts`:
```ts
import { type Db, listSyncableMailAccounts } from "@replywise/db";
import type { Logger } from "@replywise/observability";
import type { JobQueue } from "@replywise/queue";

export const SYNC_INTERVAL_MS = 120_000;
export const syncSchedulerId = (mailAccountId: string) => `mailbox.sync:${mailAccountId}`;

/**
 * Keeps one 2-minute sync schedule per active Gmail mailbox and removes the rest
 * (disconnected, needing reauth, or unsupported providers).
 */
export function reconcileSyncSchedulesHandler(deps: { db: Db; queue: JobQueue; logger: Logger }) {
  return async (): Promise<void> => {
    const wanted = (await listSyncableMailAccounts(deps.db)).filter((m) => m.provider === "gmail");
    const wantedIds = new Set(wanted.map((m) => syncSchedulerId(m.id)));
    for (const mailbox of wanted) {
      await deps.queue.scheduleRepeating(
        syncSchedulerId(mailbox.id),
        "mailbox.sync",
        { mailAccountId: mailbox.id },
        SYNC_INTERVAL_MS,
      );
    }
    let removed = 0;
    for (const id of await deps.queue.listRepeating("sync")) {
      if (!wantedIds.has(id)) {
        await deps.queue.removeRepeating("sync", id);
        removed += 1;
      }
    }
    deps.logger.info({ scheduled: wanted.length, removed }, "reconciled sync schedules");
  };
}
```

`apps/worker/src/deps.ts`:
```ts
import type { WorkerEnv } from "@replywise/config";
import { createEncryptor, LocalKeyProvider } from "@replywise/crypto";
import type { Db } from "@replywise/db";
import { createGmailApi, createMailOAuthProviders, type GmailApiFactory } from "@replywise/mail";
import type { SyncDeps } from "@replywise/sync";

export function buildSyncDeps(env: WorkerEnv, db: Db, gmail?: GmailApiFactory): SyncDeps {
  return {
    db,
    encryptor: createEncryptor(LocalKeyProvider.fromEnv(env.LOCAL_KEKS)),
    providers: createMailOAuthProviders({
      gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET },
      outlook: { clientId: env.OUTLOOK_CLIENT_ID, clientSecret: env.OUTLOOK_CLIENT_SECRET },
    }),
    gmail: gmail ?? ((accessToken) => createGmailApi(accessToken)),
  };
}
```

Replace `apps/worker/src/main.ts`:
```ts
import type { WorkerEnv } from "@replywise/config";
import { createDb } from "@replywise/db";
import type { GmailApiFactory } from "@replywise/mail";
import type { Logger } from "@replywise/observability";
import { createJobQueue, createJobWorker, createRedisConnection } from "@replywise/queue";
import type { Worker } from "bullmq";
import { buildSyncDeps } from "./deps";
import { purgeBodiesHandler } from "./jobs/purge-bodies";
import { purgeOAuthStatesHandler } from "./jobs/purge-oauth-states";
import { reconcileSyncSchedulesHandler } from "./jobs/reconcile-sync-schedules";
import { syncMailboxHandler } from "./jobs/sync-mailbox";

export const PURGE_BODIES_SCHEDULER_ID = "maintenance.purgeBodies:hourly";
export const PURGE_OAUTH_STATES_SCHEDULER_ID = "maintenance.purgeOAuthStates:hourly";
export const RECONCILE_SCHEDULER_ID = "maintenance.reconcileSyncSchedules:minutely";
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const SYNC_CONCURRENCY = 4;

export async function startWorker(
  env: WorkerEnv,
  logger: Logger,
  options: { queuePrefix?: string; gmail?: GmailApiFactory } = {},
) {
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  const queueConnection = createRedisConnection(env.REDIS_URL);
  const maintenanceConnection = createRedisConnection(env.REDIS_URL);
  const syncConnection = createRedisConnection(env.REDIS_URL);
  const prefix = options.queuePrefix ? { prefix: options.queuePrefix } : {};
  const queue = createJobQueue(queueConnection, prefix);
  const syncDeps = buildSyncDeps(env, db, options.gmail);

  const maintenanceWorker = createJobWorker(
    "maintenance",
    maintenanceConnection,
    {
      "maintenance.purgeBodies": purgeBodiesHandler({ db, logger }),
      "maintenance.purgeOAuthStates": purgeOAuthStatesHandler({ db, logger }),
      "maintenance.reconcileSyncSchedules": reconcileSyncSchedulesHandler({ db, queue, logger }),
    },
    { concurrency: 1, ...prefix },
  );
  const syncWorker = createJobWorker(
    "sync",
    syncConnection,
    { "mailbox.sync": syncMailboxHandler({ syncDeps, logger }) },
    { concurrency: SYNC_CONCURRENCY, ...prefix },
  );
  for (const worker of [maintenanceWorker, syncWorker] as Worker[]) {
    worker.on("failed", (job, error) => {
      logger.error(
        { jobId: job?.id, jobName: job?.name, error: { name: error.name, message: error.message } },
        "job failed",
      );
    });
  }

  await queue.scheduleRepeating(PURGE_BODIES_SCHEDULER_ID, "maintenance.purgeBodies", {}, ONE_HOUR_MS);
  await queue.scheduleRepeating(
    PURGE_OAUTH_STATES_SCHEDULER_ID,
    "maintenance.purgeOAuthStates",
    {},
    ONE_HOUR_MS,
  );
  await queue.scheduleRepeating(
    RECONCILE_SCHEDULER_ID,
    "maintenance.reconcileSyncSchedules",
    {},
    ONE_MINUTE_MS,
  );
  logger.info("worker started");

  return {
    async stop(): Promise<void> {
      await Promise.all([maintenanceWorker.close(), syncWorker.close()]);
      await queue.close();
      await Promise.all([
        queueConnection.quit(),
        maintenanceConnection.quit(),
        syncConnection.quit(),
      ]);
      await closeDb();
      logger.info("worker stopped");
    },
  };
}
```
(`apps/worker/src/index.ts` needs no change: it calls `startWorker(env, logger)`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/queue test:int && pnpm --filter @replywise/worker test:int && pnpm --filter @replywise/worker build && pnpm typecheck && pnpm --filter @replywise/mail test && pnpm format && pnpm lint`
Expected: queue 7 PASS, worker 5 PASS; worker bundle builds; the no-send guard (scanning `apps/worker/src`) passes; typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): schedule per-mailbox Gmail sync and reconcile schedules"
```

---

### Task 7: Web — inbox thread list and mailbox sync status

**Files:**
- Create: `apps/web/src/lib/inbox-format.ts`, `apps/web/src/lib/inbox-format.test.ts`
- Create: `apps/web/src/components/inbox/thread-list.tsx`
- Modify: `apps/web/src/app/(app)/inbox/page.tsx`, `apps/web/src/components/mailboxes/mailbox-list.tsx`
- Create: `apps/web/e2e/seed.ts`, `apps/web/e2e/inbox.spec.ts`

**Interfaces:**
- Consumes: `listInboxThreads`, `listMailAccounts`, `MailAccountSummary` (db), `requireUser`, `getDb`, `EmptyInbox`.
- Produces: `formatParticipants(participants: EmailAddress[], ownEmails: string[]): string`; `formatThreadTime(date: Date, now: Date, timeZone?: string): string`; `formatSyncStatus(account: { status; lastSyncedAt: Date | null; lastError: string | null }, now: Date): string`; e2e helpers `seedMailbox(email, options)` / `seedThread(...)` in `e2e/seed.ts`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/inbox-format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatParticipants, formatSyncStatus, formatThreadTime } from "./inbox-format";

describe("formatParticipants", () => {
  it("names other people first, falls back to addresses, and summarises extras", () => {
    expect(
      formatParticipants(
        [
          { name: null, address: "me@gmail.com" },
          { name: "Ada Lovelace", address: "ada@x.com" },
          { name: null, address: "bob@y.com" },
          { name: "Carol", address: "carol@z.com" },
        ],
        ["me@gmail.com"],
      ),
    ).toBe("Ada Lovelace, bob@y.com +1");
  });

  it("shows 'me' when the only participant is the owner", () => {
    expect(formatParticipants([{ name: "Me", address: "me@gmail.com" }], ["me@gmail.com"])).toBe("me");
    expect(formatParticipants([], [])).toBe("(no sender)");
  });
});

describe("formatThreadTime", () => {
  const now = new Date("2026-11-17T15:00:00Z");
  it("uses the time for today, month/day this year, and the full date otherwise", () => {
    expect(formatThreadTime(new Date("2026-11-17T09:05:00Z"), now, "UTC")).toBe("09:05");
    expect(formatThreadTime(new Date("2026-03-04T09:05:00Z"), now, "UTC")).toBe("Mar 4");
    expect(formatThreadTime(new Date("2025-12-31T09:05:00Z"), now, "UTC")).toBe("Dec 31, 2025");
  });
});

describe("formatSyncStatus", () => {
  const now = new Date("2026-11-17T15:00:00Z");
  it("describes never-synced, recent, older and failing mailboxes", () => {
    expect(formatSyncStatus({ status: "active", lastSyncedAt: null, lastError: null }, now)).toBe(
      "Syncing your inbox…",
    );
    expect(
      formatSyncStatus(
        { status: "active", lastSyncedAt: new Date("2026-11-17T14:59:30Z"), lastError: null },
        now,
      ),
    ).toBe("Synced just now");
    expect(
      formatSyncStatus(
        { status: "active", lastSyncedAt: new Date("2026-11-17T14:40:00Z"), lastError: null },
        now,
      ),
    ).toBe("Synced 20 min ago");
    expect(
      formatSyncStatus(
        {
          status: "active",
          lastSyncedAt: new Date("2026-11-17T12:00:00Z"),
          lastError: "Gmail API request failed (500)",
        },
        now,
      ),
    ).toBe("Last sync failed: Gmail API request failed (500)");
    expect(formatSyncStatus({ status: "needs_reauth", lastSyncedAt: null, lastError: "x" }, now)).toBe(
      "Paused until you reconnect",
    );
  });
});
```

`apps/web/e2e/seed.ts`:
```ts
import { aad, createEncryptor, LocalKeyProvider } from "@replywise/crypto";
import { createDb, mailAccounts, messages, threads, users } from "@replywise/db";
import { eq } from "drizzle-orm";

/** Direct DB seeding for e2e. Uses the same DATABASE_URL and LOCAL_KEKS as the server. */
export async function withSeed<T>(
  fn: (seed: {
    mailbox: (userEmail: string, overrides?: Partial<typeof mailAccounts.$inferInsert>) => Promise<string>;
    thread: (
      mailAccountId: string,
      input: {
        subject: string;
        snippet: string;
        unread?: boolean;
        html?: string;
        text?: string;
        from?: string;
        at?: Date;
      },
    ) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  const url = process.env.DATABASE_URL;
  const keks = process.env.LOCAL_KEKS;
  if (!url || !keks) throw new Error("DATABASE_URL and LOCAL_KEKS must be set for e2e seeding");
  const { db, close } = createDb(url, { max: 1 });
  const encryptor = createEncryptor(LocalKeyProvider.fromEnv(keks));
  try {
    return await fn({
      async mailbox(userEmail, overrides = {}) {
        const [user] = await db.select().from(users).where(eq(users.email, userEmail));
        if (!user) throw new Error(`no user ${userEmail}`);
        const [row] = await db
          .insert(mailAccounts)
          .values({
            userId: user.id,
            provider: "gmail",
            emailAddress: `seed-${Date.now()}@gmail.com`,
            tokensCiphertext: Buffer.from("seed"),
            ...overrides,
          })
          .returning({ id: mailAccounts.id });
        if (!row) throw new Error("seed mailbox failed");
        return row.id;
      },
      async thread(mailAccountId, input) {
        const sentAt = input.at ?? new Date();
        const from = input.from ?? "ada@example.com";
        const [thread] = await db
          .insert(threads)
          .values({
            mailAccountId,
            providerThreadId: `seed-${Math.random().toString(36).slice(2)}`,
            subject: input.subject,
            snippet: input.snippet,
            participants: [{ name: "Ada Lovelace", address: from }],
            lastMessageAt: sentAt,
            messageCount: 1,
            isUnread: input.unread ?? false,
            providerLabels: input.unread ? ["INBOX", "UNREAD"] : ["INBOX"],
          })
          .returning({ id: threads.id });
        if (!thread) throw new Error("seed thread failed");
        const [message] = await db
          .insert(messages)
          .values({
            threadId: thread.id,
            mailAccountId,
            providerMessageId: `seed-${Math.random().toString(36).slice(2)}`,
            fromAddress: { name: "Ada Lovelace", address: from },
            subject: input.subject,
            snippet: input.snippet,
            sentAt,
          })
          .returning({ id: messages.id });
        if (!message) throw new Error("seed message failed");
        if (input.html !== undefined || input.text !== undefined) {
          const body = await encryptor.encrypt(
            JSON.stringify({ text: input.text ?? null, html: input.html ?? null }),
            aad.messageBody(message.id),
          );
          await db
            .update(messages)
            .set({ bodyCiphertext: body, bodyExpiresAt: new Date(Date.now() + 86_400_000) })
            .where(eq(messages.id, message.id));
        }
        return thread.id;
      },
    });
  } finally {
    await close();
  }
}
```
Add `drizzle-orm` and `@replywise/crypto` to `apps/web` devDependencies if the e2e import of `drizzle-orm` fails to resolve (`pnpm --filter @replywise/web add -D drizzle-orm` — `@replywise/crypto` is already a dependency).

`apps/web/e2e/inbox.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

test("a mailbox that has not synced yet shows a syncing state", async ({ page }) => {
  const email = await signUp(page);
  await withSeed((seed) => seed.mailbox(email));
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Syncing your inbox…" })).toBeVisible();
});

test("synced threads are listed newest first with unread emphasis", async ({ page }) => {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    const mailbox = await seed.mailbox(email, { lastSyncedAt: new Date() });
    await seed.thread(mailbox, {
      subject: "Quarterly numbers",
      snippet: "See attached",
      at: new Date(Date.now() - 3_600_000),
    });
    await seed.thread(mailbox, {
      subject: "Lunch tomorrow?",
      snippet: "Noon works",
      unread: true,
      at: new Date(Date.now() - 60_000),
    });
  });
  await page.goto("/inbox");
  const rows = page.getByRole("link", { name: /Lunch tomorrow\?|Quarterly numbers/ });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Lunch tomorrow?");
  await expect(rows.first()).toHaveAttribute("data-unread", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-unread", "false");

  await page.goto("/settings/mailboxes");
  await expect(page.getByText("Synced just now")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/web test` then `pnpm --filter @replywise/web e2e --reporter=line -g "syncing state|synced threads"`
Expected: unit FAIL (cannot resolve `./inbox-format`); e2e FAIL (inbox still shows "No mailboxes connected").

- [ ] **Step 3: Implement**

`apps/web/src/lib/inbox-format.ts`:
```ts
import type { EmailAddress } from "@replywise/core";

export function formatParticipants(participants: EmailAddress[], ownEmails: string[]): string {
  if (participants.length === 0) return "(no sender)";
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  const others = participants.filter((p) => !own.has(p.address));
  if (others.length === 0) return "me";
  const names = others.map((p) => p.name ?? p.address);
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

export function formatThreadTime(date: Date, now: Date, timeZone?: string): string {
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  if (day(date) === day(now)) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
  }
  const sameYear =
    date.toLocaleDateString("en-US", { year: "numeric", timeZone }) ===
    now.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  });
}

export function formatSyncStatus(
  account: { status: "active" | "needs_reauth" | "error"; lastSyncedAt: Date | null; lastError: string | null },
  now: Date,
): string {
  if (account.status === "needs_reauth") return "Paused until you reconnect";
  if (account.lastError) return `Last sync failed: ${account.lastError}`;
  if (!account.lastSyncedAt) return "Syncing your inbox…";
  const minutes = Math.floor((now.getTime() - account.lastSyncedAt.getTime()) / 60_000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Synced ${hours} h ago` : `Synced ${Math.floor(hours / 24)} d ago`;
}
```

`apps/web/src/components/inbox/thread-list.tsx`:
```tsx
import { listInboxThreads, listMailAccounts } from "@replywise/db";
import Link from "next/link";
import { connection } from "next/server";
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { formatParticipants, formatThreadTime } from "@/lib/inbox-format";
import { cn } from "@/lib/utils";

/** Reads the session and DB; render inside <Suspense>. */
export async function ThreadList() {
  const user = await requireUser();
  await connection();
  const db = getDb();
  const mailboxes = await listMailAccounts(db, user.id);
  if (mailboxes.length === 0) {
    return (
      <EmptyInbox
        title="No mailboxes connected"
        description="Connect Gmail and Replywise will bring in your last 30 days of mail. Classification into Urgent, Important, Needs Reply, Informational and Low Priority arrives next."
        action={
          <Button asChild size="sm">
            <Link href="/settings/mailboxes">Connect a mailbox</Link>
          </Button>
        }
      />
    );
  }

  const threads = await listInboxThreads(db, user.id);
  if (threads.length === 0) {
    const syncing = mailboxes.some((m) => m.status === "active" && m.lastSyncedAt === null);
    return syncing ? (
      <EmptyInbox
        title="Syncing your inbox…"
        description="Replywise is bringing in the last 30 days of mail. This usually takes a minute or two."
      />
    ) : (
      <EmptyInbox title="You're all caught up" description="There is nothing in your inbox right now." />
    );
  }

  const now = new Date();
  const ownEmails = mailboxes.map((m) => m.emailAddress);
  return (
    <ul className="divide-y divide-border">
      {threads.map((thread) => (
        <li key={thread.id}>
          <Link
            href={`/thread/${thread.id}`}
            data-unread={thread.isUnread ? "true" : "false"}
            className="flex flex-col gap-0.5 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:px-6"
          >
            <div className="flex items-baseline gap-3">
              {thread.isUnread ? (
                <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
              ) : null}
              <span className={cn("min-w-0 flex-1 truncate text-sm", thread.isUnread && "font-semibold")}>
                {formatParticipants(thread.participants, ownEmails)}
              </span>
              <time
                dateTime={thread.lastMessageAt.toISOString()}
                className="shrink-0 text-xs text-muted-foreground"
              >
                {formatThreadTime(thread.lastMessageAt, now)}
              </time>
            </div>
            <p className={cn("truncate text-sm", thread.isUnread ? "font-medium" : "text-foreground/90")}>
              {thread.subject || "(no subject)"}
              {thread.messageCount > 1 ? (
                <span className="ml-1.5 text-xs text-muted-foreground">{thread.messageCount}</span>
              ) : null}
            </p>
            <p className="truncate text-sm text-muted-foreground">{thread.snippet}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ThreadListSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:px-6" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
```

Replace `apps/web/src/app/(app)/inbox/page.tsx`:
```tsx
import { Suspense } from "react";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export const metadata = { title: "All mail" };

export default function InboxPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">All mail</h1>
      <Suspense fallback={<ThreadListSkeleton />}>
        <ThreadList />
      </Suspense>
    </div>
  );
}
```
Note: the existing e2e test asserting the heading "No mailboxes connected" still passes (EmptyInbox renders an `<h1>`); the hidden "All mail" `<h1>` keeps the page title accessible when the list is shown.

In `apps/web/src/components/mailboxes/mailbox-list.tsx`: `listMailAccounts` already returns `lastSyncedAt` and `lastError`. Import `formatSyncStatus` from `@/lib/inbox-format` and `connection` from `next/server`; call `await connection();` after `requireUser()`; compute `const now = new Date();` and replace the provider line under the email with:
```tsx
                  <p className="text-xs text-muted-foreground">
                    {PROVIDER_LABEL[account.provider]} · {formatSyncStatus(account, now)}
                  </p>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @replywise/web test && pnpm --filter @replywise/web typecheck && pnpm format && pnpm lint`, then `pnpm --filter @replywise/web e2e --reporter=line`
Expected: web unit 26 PASS (22 + 4); e2e 14 PASS (12 + 2). The `connection()` call marks the render as request-time so `new Date()` is allowed under `cacheComponents` (see `node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`, "Sync IO").

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): inbox thread list and mailbox sync status"
```

---

### Task 8: Thread view with sanitized HTML and on-demand body refetch

**Files:**
- Create: `packages/sync/src/thread-view.ts`, `packages/sync/src/thread-view.int.test.ts`; modify `packages/sync/src/index.ts`
- Create: `apps/web/src/lib/{sync,email-html}.ts`, `apps/web/src/lib/email-html.test.ts`
- Create: `apps/web/src/components/thread/{thread-view,email-frame}.tsx`, `apps/web/src/app/(app)/thread/[id]/page.tsx`
- Modify: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/e2e/inbox.spec.ts`

**Interfaces:**
- Consumes: `getThreadForUser` (db), `decryptBody`, `persistThreads`, `SyncDeps` (sync), `getValidAccessToken`, `ReauthRequiredError` (mailbox).
- Produces: `interface ThreadViewMessage { id; from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; sentAt: Date; isFromUser: boolean; snippet: string; body: { text: string | null; html: string | null } | null }`; `interface ThreadView { id; subject; providerThreadId; mailbox: { provider; emailAddress }; messages: ThreadViewMessage[]; bodiesUnavailable: boolean }`; `loadThreadForUser(deps: SyncDeps, userId: string, threadId: string): Promise<ThreadView | null>`; web `getSyncDeps(): SyncDeps`; `sanitizeEmailHtml(html: string): string`; `buildEmailDocument(sanitizedHtml: string): string`; `gmailThreadUrl(email: string, providerThreadId: string): string`.

- [ ] **Step 1: Write the failing tests**

`packages/sync/src/thread-view.int.test.ts`:
```ts
import { type Db, messages } from "@replywise/db";
import { insertUser, resetTestDb, setupTestDb } from "@replywise/db/testing";
import { completeConnect, startConnect } from "@replywise/mailbox";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SyncDeps } from "./deps";
import { syncMailbox } from "./sync-mailbox";
import { createFakeGmail, fakeMessage } from "./testing";
import { loadThreadForUser } from "./thread-view";

const T0 = new Date("2026-11-17T12:00:00Z");
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function syncedMailbox() {
  const provider = createFakeProvider("gmail", { email: "me@gmail.com" });
  const encryptor = testEncryptor();
  const user = await insertUser(db);
  const base = { db, encryptor, providers: { gmail: provider.provider }, now: () => T0 };
  const url = await startConnect(base, { userId: user.id, provider: "gmail", redirectUri: "http://cb" });
  const state = new URL(url).searchParams.get("state") ?? "";
  const { mailAccountId } = await completeConnect(base, {
    userId: user.id, provider: "gmail", code: "c", state, redirectUri: "http://cb",
  });
  const gmail = createFakeGmail({
    threads: {
      t1: [
        fakeMessage({ providerMessageId: "m1", providerThreadId: "t1", bodyHtml: "<p>one</p>", bodyText: "one" }),
        fakeMessage({ providerMessageId: "m2", providerThreadId: "t1", bodyText: "two", sentAt: new Date("2026-11-16T00:00:00Z") }),
      ],
    },
  });
  const deps: SyncDeps = { ...base, gmail: gmail.factory };
  await syncMailbox(deps, mailAccountId);
  const [row] = await db.select({ threadId: messages.threadId }).from(messages).limit(1);
  if (!row) throw new Error("sync stored nothing");
  return { deps, gmail, userId: user.id, threadId: row.threadId };
}

describe("loadThreadForUser", () => {
  it("returns decrypted bodies oldest first without calling Gmail", async () => {
    const { deps, gmail, userId, threadId } = await syncedMailbox();
    const factoryCalls = gmail.calls.factory;
    const view = await loadThreadForUser(deps, userId, threadId);
    expect(view?.messages.map((m) => m.body)).toEqual([
      { text: "one", html: "<p>one</p>" },
      { text: "two", html: null },
    ]);
    expect(view?.bodiesUnavailable).toBe(false);
    expect(view?.mailbox).toEqual({ provider: "gmail", emailAddress: "me@gmail.com" });
    expect(gmail.calls.factory).toBe(factoryCalls);
  });

  it("refetches expired bodies from Gmail and caches them again", async () => {
    const { deps, gmail, userId, threadId } = await syncedMailbox();
    await db.update(messages).set({ bodyCiphertext: null, bodyExpiresAt: null });
    const view = await loadThreadForUser(deps, userId, threadId);
    expect(view?.messages[0]?.body?.text).toBe("one");
    expect(gmail.calls.getThread.at(-1)).toBe("t1");
    const rows = await db.select().from(messages);
    expect(rows.every((m) => m.bodyCiphertext !== null)).toBe(true);
  });

  it("returns null for another user's thread", async () => {
    const { deps, threadId } = await syncedMailbox();
    const mallory = await insertUser(db);
    expect(await loadThreadForUser(deps, mallory.id, threadId)).toBeNull();
  });

  it("marks bodies unavailable instead of failing when Gmail cannot be reached", async () => {
    const { deps, userId, threadId } = await syncedMailbox();
    await db.update(messages).set({ bodyCiphertext: null, bodyExpiresAt: null });
    const failing: SyncDeps = {
      ...deps,
      gmail: () => {
        throw new Error("offline");
      },
    };
    const view = await loadThreadForUser(failing, userId, threadId);
    expect(view?.bodiesUnavailable).toBe(true);
    expect(view?.messages.every((m) => m.body === null)).toBe(true);
  });
});
```

`apps/web/src/lib/email-html.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildEmailDocument, gmailThreadUrl, sanitizeEmailHtml } from "./email-html";

describe("sanitizeEmailHtml", () => {
  it("removes scripts, event handlers, styles, forms and javascript: links", () => {
    const clean = sanitizeEmailHtml(
      '<p onclick="steal()">Hi</p><script>alert(1)</script><style>body{}</style>' +
        '<form action="https://evil"><input name="pw"></form><a href="javascript:alert(1)">x</a>',
    );
    expect(clean).toContain("<p>Hi</p>");
    expect(clean).not.toMatch(/script|onclick|<style|<form|<input|javascript:/i);
  });

  it("blocks remote images but keeps inline data images and formatting", () => {
    const clean = sanitizeEmailHtml(
      '<img src="https://tracker.example/p.gif"><img src="data:image/png;base64,AAAA" alt="logo">' +
        "<table><tr><td><b>bold</b> <i>it</i></td></tr></table>",
    );
    expect(clean).not.toContain("tracker.example");
    expect(clean).toContain('src="data:image/png;base64,AAAA"');
    expect(clean).toContain("<table>");
    expect(clean).toContain("<b>bold</b>");
  });

  it("opens links in a new tab without referrer", () => {
    expect(sanitizeEmailHtml('<a href="https://example.com/x">x</a>')).toBe(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });
});

describe("buildEmailDocument", () => {
  it("wraps the html in a document that opens links outside the frame", () => {
    const doc = buildEmailDocument("<p>Hi</p>");
    expect(doc).toMatch(/^<!doctype html>/i);
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain("<p>Hi</p>");
  });
});

describe("gmailThreadUrl", () => {
  it("deep-links to the thread in the right Gmail account", () => {
    expect(gmailThreadUrl("me@gmail.com", "18c2")).toBe(
      "https://mail.google.com/mail/u/?authuser=me%40gmail.com#all/18c2",
    );
  });
});
```

Append to `apps/web/e2e/inbox.spec.ts`:
```ts
test("opening a thread renders sanitized HTML that cannot run scripts or load trackers", async ({ page }) => {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    const mailbox = await seed.mailbox(email, { lastSyncedAt: new Date() });
    await seed.thread(mailbox, {
      subject: "Hello from Ada",
      snippet: "Hi there",
      html:
        '<p>Hi <b>there</b></p><img src="https://tracker.example/pixel.gif">' +
        '<img src="x" onerror="parent.document.title=\'pwned\'"><script>parent.document.title="pwned"</script>',
    });
  });
  const trackerRequests: string[] = [];
  await page.route("https://tracker.example/**", async (route) => {
    trackerRequests.push(route.request().url());
    await route.abort();
  });

  await page.goto("/inbox");
  await page.getByRole("link", { name: /Hello from Ada/ }).click();
  await expect(page).toHaveURL(/\/thread\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Hello from Ada" })).toBeVisible();
  const frame = page.frameLocator('iframe[title="Email content"]');
  await expect(frame.getByText("Hi there")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.title()).not.toBe("pwned");
  expect(trackerRequests).toEqual([]);
});

test("unknown or foreign thread ids show not found", async ({ page }) => {
  await signUp(page);
  await page.goto("/thread/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("This page could not be found")).toBeVisible();
  await page.goto("/thread/not-a-uuid");
  await expect(page.getByText("This page could not be found")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @replywise/sync test:int; pnpm --filter @replywise/web test`
Expected: FAIL — `./thread-view` and `./email-html` not found.

- [ ] **Step 3: Implement thread loading**

`packages/sync/src/thread-view.ts`:
```ts
import type { EmailAddress, MailProviderId } from "@replywise/core";
import { getThreadForUser } from "@replywise/db";
import { getValidAccessToken } from "@replywise/mailbox";
import { decryptBody, type MessageBody } from "./body-codec";
import type { SyncDeps } from "./deps";
import { persistThreads } from "./persist";

export interface ThreadViewMessage {
  id: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  sentAt: Date;
  isFromUser: boolean;
  snippet: string;
  body: MessageBody | null;
}

export interface ThreadView {
  id: string;
  subject: string;
  providerThreadId: string;
  mailbox: { provider: MailProviderId; emailAddress: string };
  messages: ThreadViewMessage[];
  /** True when some bodies were missing and could not be refetched from the provider. */
  bodiesUnavailable: boolean;
}

/**
 * Loads a thread the user owns, decrypting cached bodies. Bodies whose cache expired are
 * refetched from Gmail and cached again; if that fails the view still renders with snippets.
 */
export async function loadThreadForUser(
  deps: SyncDeps,
  userId: string,
  threadId: string,
): Promise<ThreadView | null> {
  let detail = await getThreadForUser(deps.db, userId, threadId);
  if (!detail) return null;

  const missing = detail.messages.some((m) => m.bodyCiphertext === null);
  let bodiesUnavailable = false;
  if (missing) {
    try {
      if (detail.mailbox.provider !== "gmail" || detail.mailbox.status === "needs_reauth") {
        throw new Error("cannot refetch");
      }
      const { accessToken } = await getValidAccessToken(deps, detail.mailbox.id);
      const thread = await deps.gmail(accessToken).getThread(detail.thread.providerThreadId);
      if (thread) {
        const mailbox = { id: detail.mailbox.id, userId, emailAddress: detail.mailbox.emailAddress };
        await deps.db.transaction((tx) =>
          persistThreads(tx, deps.encryptor, mailbox, [thread], new Date()),
        );
        detail = (await getThreadForUser(deps.db, userId, threadId)) ?? detail;
      }
      bodiesUnavailable = detail.messages.some((m) => m.bodyCiphertext === null);
    } catch {
      bodiesUnavailable = true;
    }
  }

  const messages: ThreadViewMessage[] = [];
  for (const m of detail.messages) {
    messages.push({
      id: m.id,
      from: m.fromAddress,
      to: m.toAddresses,
      cc: m.ccAddresses,
      sentAt: m.sentAt,
      isFromUser: m.isFromUser,
      snippet: m.snippet,
      body: m.bodyCiphertext ? await decryptBody(deps.encryptor, m.id, m.bodyCiphertext) : null,
    });
  }
  return {
    id: detail.thread.id,
    subject: detail.thread.subject,
    providerThreadId: detail.thread.providerThreadId,
    mailbox: { provider: detail.mailbox.provider, emailAddress: detail.mailbox.emailAddress },
    messages,
    bodiesUnavailable,
  };
}
```
Add `export * from "./thread-view";` to `packages/sync/src/index.ts`.

- [ ] **Step 4: Implement the web pieces**

```bash
pnpm --filter @replywise/web add "@replywise/sync@workspace:*" sanitize-html
pnpm --filter @replywise/web add -D @types/sanitize-html
```
Add `"@replywise/sync"` to `transpilePackages` in `apps/web/next.config.ts`.

`apps/web/src/lib/sync.ts`:
```ts
import "server-only";
import { createGmailApi } from "@replywise/mail";
import type { SyncDeps } from "@replywise/sync";
import { getMailboxDeps } from "./mailbox";

export function getSyncDeps(): SyncDeps {
  return { ...getMailboxDeps(), gmail: (accessToken) => createGmailApi(accessToken) };
}
```

`apps/web/src/lib/email-html.ts`:
```ts
import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "dd", "div", "dl", "dt",
  "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre",
  "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "u", "ul",
];

/** Server-side sanitizer for email HTML: no scripts, handlers, styles, forms or remote images. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan", "align", "valign", "width"],
      th: ["colspan", "rowspan", "align", "valign", "width"],
      table: ["width", "align", "cellpadding", "cellspacing", "border"],
      "*": ["dir"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      }),
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

/** Wraps sanitized HTML for an <iframe srcDoc>; links open outside the frame. */
export function buildEmailDocument(sanitizedHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;color:#18181b;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid #e4e4e7;color:#52525b}</style></head><body>${sanitizedHtml}</body></html>`;
}

export function gmailThreadUrl(email: string, providerThreadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(providerThreadId)}`;
}
```

`apps/web/src/components/thread/email-frame.tsx`:
```tsx
"use client";

import { useCallback, useRef } from "react";

/**
 * Renders sanitized email HTML in a sandboxed iframe: no scripts (no allow-scripts), links may
 * open new tabs. allow-same-origin lets the parent measure the content height; without
 * allow-scripts the frame still cannot run code.
 */
export function EmailFrame({ srcDoc }: { srcDoc: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const resize = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (ref.current && doc) ref.current.style.height = `${doc.documentElement.scrollHeight + 4}px`;
  }, []);
  return (
    <iframe
      ref={ref}
      title="Email content"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={resize}
      className="h-40 w-full rounded-md border border-border bg-white"
    />
  );
}
```

`apps/web/src/components/thread/thread-view.tsx`:
```tsx
import type { ThreadView as ThreadViewData } from "@replywise/sync";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { buildEmailDocument, gmailThreadUrl, sanitizeEmailHtml } from "@/lib/email-html";
import { formatThreadTime } from "@/lib/inbox-format";
import { EmailFrame } from "./email-frame";

const name = (a: { name: string | null; address: string }) => a.name ?? a.address;

export function ThreadView({ view, now }: { view: ThreadViewData; now: Date }) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
        ← All mail
      </Link>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{view.subject || "(no subject)"}</h1>
        {view.mailbox.provider === "gmail" ? (
          <a
            href={gmailThreadUrl(view.mailbox.emailAddress, view.providerThreadId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Open in Gmail <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </header>
      {view.bodiesUnavailable ? (
        <p role="status" className="mt-4 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
          Some message bodies could not be loaded right now. Showing previews instead.
        </p>
      ) : null}
      <ol className="mt-6 flex flex-col gap-4">
        {view.messages.map((message) => (
          <li key={message.id} className="rounded-lg border border-border">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
              <p className="text-sm">
                <span className="font-medium">{message.isFromUser ? "You" : name(message.from)}</span>{" "}
                <span className="text-muted-foreground">
                  to {message.to.map(name).join(", ") || "(no recipients)"}
                </span>
              </p>
              <time dateTime={message.sentAt.toISOString()} className="text-xs text-muted-foreground">
                {formatThreadTime(message.sentAt, now)}
              </time>
            </div>
            <div className="p-3">
              {message.body?.html ? (
                <EmailFrame srcDoc={buildEmailDocument(sanitizeEmailHtml(message.body.html))} />
              ) : (
                <p className="whitespace-pre-wrap px-1 text-sm">
                  {message.body?.text ?? message.snippet}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}
```

`apps/web/src/app/(app)/thread/[id]/page.tsx`:
```tsx
import { loadThreadForUser } from "@replywise/sync";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ThreadView } from "@/components/thread/thread-view";
import { requireUser } from "@/lib/auth";
import { getSyncDeps } from "@/lib/sync";

export const metadata = { title: "Thread" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ThreadContent({ params }: { params: PageProps<"/thread/[id]">["params"] }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const view = await loadThreadForUser(getSyncDeps(), user.id, id);
  if (!view) notFound();
  return <ThreadView view={view} now={new Date()} />;
}

export default function ThreadPage({ params }: PageProps<"/thread/[id]">) {
  return (
    <Suspense fallback={<div className="mx-auto h-64 w-full max-w-3xl animate-pulse px-6 py-6" />}>
      <ThreadContent params={params} />
    </Suspense>
  );
}
```
(Run `pnpm --filter @replywise/web typecheck` first so `next typegen` generates the `/thread/[id]` route types.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @replywise/sync test:int && pnpm --filter @replywise/web test && pnpm --filter @replywise/web typecheck && pnpm format && pnpm lint && pnpm --filter @replywise/web build`, then `pnpm --filter @replywise/web e2e --reporter=line`
Expected: sync integration 11 PASS (7 + 4); web unit 31 PASS (26 + 5); build lists `◐ /thread/[id]`; e2e 16 PASS (14 + 2). If the iframe content does not render in e2e because of the app CSP, read the console error, and if `frame-src` is the cause add `frame-src 'self'` to `contentSecurityPolicy()` in `apps/web/src/lib/security-headers.ts` with a test asserting it (srcdoc frames are same-origin documents).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: thread view with sanitized sandboxed email HTML and body refetch"
```

---

### Task 9: Docs, full verification and real-Gmail check

**Files:**
- Modify: `README.md`, `docs/superpowers/notes/2026-11-16-m2-followups.md`

- [ ] **Step 1: Document running sync**

Append to `README.md`:
````markdown
## Syncing mail in development

The worker syncs every active Gmail mailbox: the last 30 days of inbox threads on the first run,
then changes every 2 minutes (schedules are reconciled once a minute, so a new mailbox starts
within about a minute of connecting).

```bash
docker compose up -d --wait
pnpm db:migrate
pnpm --filter @replywise/worker dev   # terminal 1 — needs GMAIL_CLIENT_ID/SECRET in .env to refresh tokens
pnpm --filter @replywise/web dev      # terminal 2
```

Message bodies are cached encrypted for `body_cache_days` (default 14) and refetched on demand
when you open an older thread. Replywise only reads mail; it never sends.
````

In `docs/superpowers/notes/2026-11-16-m2-followups.md`, under "Carry into the M3 (sync) plan", append ` — done in M3` to each line that Tasks 1, 3, 6 and 7 addressed (unlocked fast path, no status clobber, no-send guard to worker, test gaps listed in Task 1, inbox empty state), and add a new section:
```markdown
## M3 decisions to revisit

- Sync schedules are created by a once-a-minute reconcile job in the worker instead of being
  enqueued by the web app on connect (keeps Redis out of the web app); first sync starts within ~1 minute.
- Email HTML keeps no inline styles (sanitize-html allow-list); layout-heavy newsletters render plainly.
- Outlook mailboxes are not synced yet (Graph delta sync is the next milestone).
```

- [ ] **Step 2: Full automated verification**

Run (Postgres/Redis already running from the main checkout; do not run compose from the worktree):
```bash
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test && pnpm test:int && pnpm --filter @replywise/web e2e --reporter=line
```
Expected: everything passes.

- [ ] **Step 3: Manual verification with the real Gmail account** (user present; `GMAIL_CLIENT_ID/SECRET` in the worktree `.env`)

1. Start the worker and web app (commands above, from the worktree).
2. Sign in, connect Gmail (Settings → Mailboxes). Within ~2 minutes the mailbox shows "Synced just now" and `/inbox` lists recent threads.
3. Open a thread with HTML content: it renders inside the frame; "Open in Gmail" opens the same thread.
4. Send yourself a new email from another account; within ~2 minutes it appears at the top of `/inbox`.
5. Check encryption at rest:
```bash
"/c/Program Files/Docker/Docker/resources/bin/docker.exe" compose --project-directory /d/replywise exec -T postgres psql -U replywise -d replywise -tAc "select count(*), count(body_ciphertext), sum(position('<html' in lower(encode(body_ciphertext,'escape')))) from messages;"
```
Expected: bodies stored for most messages and the last column `0` (no plaintext HTML).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: document Gmail sync and record M3 decisions"
```

---

## Definition of done (M3)

- A connected Gmail mailbox backfills its last 30 days of inbox threads and then stays current every ~2 minutes, including deletions and label changes; an expired history id triggers a bounded re-backfill.
- At most one sync runs per mailbox at a time; failures leave a fixed, non-secret `last_error` and keep the previous cursor; reauth-needed mailboxes are paused.
- Bodies exist only encrypted with row-bound AAD and expire per `body_cache_days`; expired bodies are refetched on demand.
- `/inbox` lists the user's threads; `/thread/[id]` shows the conversation with sanitized HTML in a script-less sandboxed frame; other users' threads are unreachable.
- No code path references a send endpoint (guard covers mail, mailbox, sync and worker).
- All automated suites pass; a real Gmail account was synced and browsed manually.
