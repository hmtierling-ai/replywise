# M6 — Confirmed sending, Sent sync, Gmail tab filter, search

- **Date:** 2026-11-25
- **Status:** Approved in brainstorming, awaiting spec review
- **Parent spec:** `docs/superpowers/specs/2026-11-15-replywise-design.md` (this milestone amends §1, §8, §9 and §10 there)
- **Provider scope:** Gmail only for sending, Sent sync, Gmail search and import. Outlook keeps working as before and gets local search only.

## 1. Goals and decisions

| Topic | Decision |
|---|---|
| Sending | Replywise may send **replies only**, and only after an explicit user click plus a confirmation dialog. Never automatically: AI jobs and auto-draft never send. |
| Undo | Confirmed sends wait **10 seconds** with an "Undo" button before anything reaches Gmail. |
| Send mechanism | Save/update the provider draft (as in M5), then Gmail `drafts.send`. No `messages.send`. |
| Retries | A send is never retried after the request may have reached Gmail (no duplicates). Only a rate limit before the request is retried. |
| Sent sync | Backfill covers inbox **and** sent; a new "Sent" view lists threads labelled `SENT`. |
| Tab filter | Threads with `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL` or `CATEGORY_UPDATES` that the user never replied in are "Other": hidden from the main inbox and AI tabs, shown in a new "Other" view, never auto-classified. Fixed rule, no setting yet. |
| Search | Local search (subject, sender/participants, snippet) over all synced threads, plus an explicit "Search all of Gmail" (Gmail query syntax) whose results can be imported. Message bodies are not searched locally. |
| Scopes | No new OAuth scope: `gmail.compose` already permits `drafts.send`. Outlook sending would need `Mail.Send` and stays out. |

## 2. Sending replies

### 2.1 Data model (migration `0003_send_search.sql`)

- `draft_status` gains `scheduled`, `sending`, `sent`, `send_failed`. (Postgres 55P04: the new values are not used as defaults or in data inside this migration.)
- `reply_drafts` gains `send_at timestamptz`, `sent_at timestamptz`, `provider_message_id text`.
- Index `reply_drafts (status, send_at)` for the stuck-send scan.

State machine (all transitions are conditional `UPDATE … WHERE status = <expected>` scoped by `user_id`):

```
generated|edited|saved ──scheduleSend──▶ scheduled ──claim (worker)──▶ sending ──▶ sent
        ▲                                   │                             │
        └──────────── undoSend ─────────────┘                             └──▶ send_failed
send_failed ──Edit──▶ edited          send_failed (send_rejected / save error) ──scheduleSend──▶ scheduled
```

- `scheduleSend` is allowed from `generated`, `edited`, `saved`, and from `send_failed` only when the error proves nothing was sent (`send_rejected` or an M5 save error code). It is refused while a save is in flight (M5 `saveRequestedAt` rule), for `pending`/`failed`/`discarded`/`sent`/`scheduled`/`sending` drafts, for `send_failed` with `send_unconfirmed` (the user must first choose "Edit", acknowledging the send may have gone out), and for non-Gmail mailboxes.
- While `scheduled` or `sending`, the draft cannot be edited, regenerated, saved or discarded.
- `undoSend` succeeds only from `scheduled`; the row returns to `edited`.

### 2.2 Flow

1. The reply composer shows **"Send…"** (Gmail mailboxes only). It opens a confirmation dialog showing the recipient (computed server-side with the same target rule as `draft.save`: `forMessageId` if not from the user, else the newest inbound message), the subject and the first 300 characters of the body. Confirm button: **"Send now"**.
2. The confirm Server Action `scheduleSend({ draftId, expectedBody })` decrypts the stored body and refuses (`draft_changed`) unless it equals `expectedBody`, so what was confirmed is what is sent. It checks the send rate limit, sets `status = scheduled`, `send_at = now + 10 s`, writes audit `draft.send_scheduled`, and enqueues `draft.send { draftId }` with `delay` up to `send_at` and jobId `send_<draftId>_<send_at ms>`.
3. The composer shows "Sending in 10 s… **Undo**". `undoSend` flips `scheduled → edited`, best-effort removes the delayed job, writes audit `draft.send_undone`.
4. Worker job `draft.send`:
   - Claims `scheduled → sending` only if `send_at <= now`; otherwise (undone, already claimed) it exits without action.
   - Ensures the provider draft holds this body (create or update, reusing M5 save code and recipient validation).
   - Calls Gmail `POST drafts/send { id: providerDraftId }`.
   - On success: `status = sent`, `sent_at`, `provider_message_id`; `markThreadAnswered`; audit `draft.sent`; enqueues `mailbox.sync` for the mailbox.
   - On a 429 **before** `drafts/send` was called, or on a 429 response from `drafts/send`: retryable (normal job attempts), the row stays `sending`.
   - Any other failure of `drafts/send` (timeout, network, 5xx, 4xx): `send_failed` with error `send_unconfirmed` (UI: "The send may or may not have gone out — check your Gmail Sent folder") or `send_rejected` for 4xx. Never retried.
   - Failure while saving the draft before sending: `send_failed` with the M5 save error code; nothing was sent.
5. Stuck rows, scanned by the existing minutely maintenance job:
   - `scheduled` with `send_at < now − 60 s` (job lost, e.g. Redis restart): re-enqueue `draft.send` (same jobId rule; the claim keeps it single).
   - `sending` for more than 10 minutes: `send_failed` / `send_unconfirmed`. Never re-sent.

### 2.3 Limits and guards

- Rate limit: at most **20 sends per user per rolling hour**, counted from `reply_drafts.sent_at` plus rows in `scheduled|sending`. Exceeding it → `send_rate_limited`.
- Send is Gmail-only; Outlook drafts keep "Save to drafts" only.
- The no-send CI guard stays, with one exact exception: the pattern `drafts/send` is allowed only in `packages/mail/src/gmail-send.ts`, and `createGmailSendApi` may be imported only by `apps/worker/src/jobs/send-draft.ts`. `messages/send`, `messages.send`, Graph `sendMail`/`/send`, `/reply`, `/forward` remain forbidden everywhere. The guard test enforces both the allowlist and the single importer.
- Audit actions: `draft.send_scheduled`, `draft.send_undone`, `draft.sent`, `draft.send_failed` (metadata: draftId, threadId, mailAccountId, error code; never body or recipients).
- Prompt-injection posture is unchanged: the AI still has no tools and cannot trigger a send. Only the confirmed Server Action creates a `scheduled` row.

### 2.4 UI states in the composer

`scheduled` → countdown + Undo; `sending` → "Sending…"; `sent` → "Sent ✓" with "Open in Gmail" and the composer locked; `send_failed` → error text per code with "Edit" (returns to `edited`) and, for `send_rejected`, "Try again" (a new confirm). The existing pending refresher polls while `scheduled`/`sending`.

## 3. Sent sync

- `BACKFILL_QUERY` becomes `(in:inbox OR in:sent) newer_than:30d` (cap unchanged at 300 threads, newest first). Incremental `history.list` already returns sent threads.
- New view `/sent`: threads whose `provider_labels` contain `SENT`, ordered by `last_message_at`, same list component, no AI category column requirement.
- Sent-only threads (no `INBOX` label) are never auto-classified (classification already requires `INBOX`).

## 4. Gmail tab filter ("Other")

- Definition, in one SQL helper used by every query that needs it: a thread is **Other** when `provider_labels && {CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_UPDATES}` and no message in the thread has `is_from_user = true`.
- Main inbox (`/inbox`) and AI category tabs: `INBOX` and not Other. Their counts follow the same rule.
- New view `/other` with filter chips (All / Promotions / Social / Updates) and a count in the nav; threads open in the normal thread view, with on-demand summary and reply.
- Auto-classification skips Other threads in both places: the sync-time enqueue and `maintenance.enqueueClassifications` (7-day scan).
- GIN index on `threads.provider_labels`.

## 5. Search

### 5.1 Local search

- A search box above the thread list (`/` focuses it); query in the URL as `/search?q=…`.
- Matches case-insensitively on `subject`, `snippet` and participant names/addresses across all of the user's synced threads (inbox, sent, other), scoped by `user_id`; newest first, limit 50. Each result shows where it lives: Inbox / Sent / Other.
- Implementation: `ILIKE` (with `%`, `_` and `\` in the user input escaped), backed by `pg_trgm` GIN indexes on `subject`, `snippet` and a new generated column `threads.participants_text` (`text GENERATED ALWAYS AS (lower(participants::text)) STORED`; jsonb→text casts are immutable). Queries shorter than 2 characters return nothing.

### 5.2 Search all of Gmail

- Below local results: **"Search all of Gmail"** (Gmail mailboxes; one button per connected Gmail mailbox when there are several).
- Server Action `searchGmail({ mailAccountId, q })`: gets a valid access token via `@replywise/mailbox`, calls `threads.list?q=<q>&maxResults=20`, then `threads.get?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date` for each (concurrency 5). Returns subject, from, date, snippet, provider thread id, and the local thread id when already synced.
- Limits: query length ≤ 200 characters; one in-flight Gmail search per user and ≤ 30 per minute (Redis counter); the query text is never logged.
- **Import:** clicking a result not yet in Replywise calls `importGmailThread({ mailAccountId, providerThreadId })`, which fetches the full thread and persists it through the sync package's existing `persistThreads` path (new exported `importThread`), then redirects to `/thread/<id>`. Imported threads are not auto-classified; summary and reply work on demand. A later re-backfill may prune an imported thread that is outside the backfill window; that is acceptable (it can be imported again).
- Errors map to fixed codes (`needs_reauth`, `rate_limited`, `gmail_error`); no provider error text reaches the UI.

## 6. Testing

- Unit: send job (claim/undo race, 429 before vs after, ambiguous failure never retried, save-failure path), recipient/expectedBody checks, Other predicate, search escaping, guard allowlist + single-importer test.
- Integration (Postgres): state transitions are conditional and user-scoped (user A cannot schedule/undo user B's draft); stuck-send scan; Other filter and counts; local search scoping; backfill query includes sent.
- E2E (Playwright, fake Gmail): Send → Undo → edit; Send → sent state; Other view and hidden-from-inbox; Sent view; local search; Gmail search + import (fake provider).
- Manual: one real reply sent from Replywise to the user's own address, verified in Gmail Sent and threaded correctly.

## 7. Out of scope

New-message compose, reply-all, forward, attachments, scheduled send beyond the 10 s undo, Outlook sending/search/import, local full-text body search, a setting to choose hidden Gmail tabs.
