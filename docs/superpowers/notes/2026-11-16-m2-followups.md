# M2 follow-ups (from task and final reviews)

Source: subagent-driven execution of `docs/superpowers/plans/2026-11-16-m2-mailbox-connection.md`.
The final whole-branch review verdict was "ready to merge with fixes"; the fixes landed in `200fd23`.

## Manual verification (done 2026-11-17)

- Real Gmail account connected through Settings → Mailboxes: status `active`, granted scopes exactly
  `gmail.readonly` + `gmail.compose`, `tokens_ciphertext` (549 bytes) contains no `ya29`/`1//`/`accessToken`
  plaintext, OAuth state consumed, `mailbox.connected` audited.
- Disconnect: row deleted, `mailbox.disconnected` audited with `revoked: true`, app removed from
  myaccount.google.com/permissions.
- Not yet verified with a real account: Outlook (no Microsoft credentials configured); the no-JS native form
  submission under CSP `form-action 'self'` (the hydrated path works).
- Developer pitfall seen during the test: credentials were first saved as `GOOGLE_CLIENT_ID/SECRET` (app login)
  instead of `GMAIL_CLIENT_ID/SECRET` (mailbox connection); `.env` files created before M2 lack the `GMAIL_*` lines.

## Carry into the M3 (sync) plan

- `getValidAccessToken` takes `SELECT … FOR UPDATE` even when the token is fresh. Add an unlocked fast path
  (lock and re-check only near expiry) and never call it inside an open transaction on the same mailbox row,
  or the sync job will self-deadlock. — done in M3
- A successful refresh sets `status: "active"` and clears `last_error`; only reset when the status was
  `needs_reauth`, so sync errors are not clobbered. — done in M3
- `completeConnect` should enqueue `mailbox.sync`; `disconnectMailbox` should remove the mailbox's scheduled jobs — done in M3 differently: the worker reconcile job schedules new mailboxes and removes schedules for disconnected ones
  (spec §5, deliberately out of M2 scope).
- Extend the no-send guard to `apps/worker/src` once it makes Gmail/Graph data calls. — done in M3
- Test gaps: refresh failing with a non-`invalid_grant` error leaves state unchanged; cross-user disconnect makes
  no revoke call and writes no audit row; `missing_refresh_token`; `startConnect` row has the expected
  `userId`/`provider`/`stateHash`; Outlook granted-scope contents; callback happy path against a stub token server. — done in M3
- UX: the inbox empty state still says "No mailboxes connected" after a mailbox is connected. — done in M3

## M3 decisions to revisit

- Sync schedules are created by a once-a-minute reconcile job in the worker instead of being
  enqueued by the web app on connect (keeps Redis out of the web app); first sync starts within ~1 minute.
- Email HTML keeps no inline styles (sanitize-html allow-list); layout-heavy newsletters render plainly.
- Outlook mailboxes are not synced yet (Graph delta sync is the next milestone).

## M6 (hardening) list

- Better Auth's rate limiter keys on `x-forwarded-for`, which clients can spoof: configure the trusted IP header
  and require the proxy to overwrite XFF. **Blocks any public deployment.**
- Audit IP is the leftmost `x-forwarded-for` (now length-capped) — trust only the proxy-provided value.
- Concurrent first connect of the same mailbox surfaces as `provider_error` (unique index prevents duplicates);
  catch the unique violation and treat it as a reconnect.
- Revoke the fresh grant when `getProfile` or the upsert fails after a successful code exchange.
- Log revoke failures (error class only); switch the callback's `console.error` to the pino logger.
- Consume the OAuth state on `error=access_denied` instead of waiting for the hourly purge.
- `getValidAccessToken` throws `ConnectError("not_configured")` outside the connect flow — use a dedicated error.
- Encrypt tokens outside the row lock once a KMS key provider is used.
- Accessibility: visible text for disabled connect buttons, explanation when a `needs_reauth` mailbox's provider
  is not configured, focus-visible styles on text links, hide decorative arrows from screen readers.
- Docs: production redirect URIs (`${APP_URL}/api/oauth/...`), Google testing-mode refresh tokens expire after
  7 days, Gmail scopes listed in the README; Google revocation is per user+client (two Replywise users sharing a
  Gmail account affect each other on disconnect); Outlook uses `prompt=select_account` rather than the spec's
  `prompt=consent`; add `@replywise/mailbox` to the spec §3 package table.
- Playwright `reuseExistingServer` can test a stale local server on :3000.
- Commit co-author trailers are inconsistent across M2 commits (Opus 5.5 vs Haiku 5.5).

## M4 decisions to revisit

- Classification is enqueued by a minutely worker scan (`maintenance.enqueueClassifications`) instead of by the sync job; it also covers keys added later and keeps Redis out of the web app. Latency: up to ~1 minute after sync.
- Category = deriveCategory(urgency, importance, needs_reply) with fixed thresholds (urgency ≥ 4 → Urgent, importance ≥ 4 → Important, needs_reply → Needs Reply, importance ≥ 2 → Informational, else Low Priority); tune with real data.
- Window: only inbox threads whose last message is within 7 days are classified (user decision 2026-11-23). Older threads stay unclassified unless new mail arrives.
- A thread whose classification fails permanently keeps its failed job id (`classify_<thread>_<message>_<keyVersionMs>`) and is not retried until a new message arrives or the key is re-saved. The scan limit (200 per minute) could be filled by such threads in very large inboxes.
- The scan limit (200) is global across all users, newest first; only backlog is delayed when it fills.
- No per-user AI enqueue rate limit yet (M6 hardening).
- isFromUser now uses Gmail's SENT label (send-as aliases) — done in M4.
- `@anthropic-ai/sdk` is pinned to 1.12.0 to respect pnpm's release-age gate; upgrade once newer releases age past it.
- Classify job ids include the AI key version (`classify_<thread>_<message>_<keyVersionMs>`), so re-saving a rejected key re-enqueues pending threads immediately; the job payload carries `messageId` and skips when a newer message exists.
- Usage is recorded before output validation (the adapter calls `create`, not `parse`), and a failed usage write never changes the classification result.
- Answered threads: when the user's message is newest, sync clears needs_reply and recomputes the category without an AI call (SQL mirror of deriveCategory, parity-tested).
- Categories on a mostly promotional mailbox came out 102 low_priority / 36 informational / 0 urgent-important-needs_reply (2026-11-24 real-key check); recalibrate deriveCategory thresholds or the prompt with person-to-person mail.
- A 401/403 invalidates only the key version the job read (`updated_at` at ms precision), so a key saved meanwhile is not rejected. Key validation is one 10 s attempt; classify calls use no SDK retries (BullMQ's backoff is the only retry layer).

## M5 decisions to revisit

- Summaries live in `thread_summaries` (not `thread_insights.summary`) so unclassified threads can be summarized.
- Replies go to the sender of the newest non-user message only (no reply-all, no Cc); the draft is threaded with In-Reply-To/References.
- The signature is appended at save time, not stored in the draft body.
- Pending UI is a 2-second `router.refresh()` poll for up to 3 minutes; no job-status API.
- Pending drafts hold a placeholder ciphertext encrypted under `aad.replyDraft("pending")` (the draft id isn't known before insert); it is never decrypted.
- Auto-draft only writes in the app; saving to Gmail is always a user click.
- The M4 race (classification resurrecting needs_reply after the user's reply) is closed by an upsert guard.
- No per-user rate limit on Summarize/Generate clicks yet (M6).
- Gmail draft creation (POST) is retried only on Gmail rate limits; any other failure (timeout, 5xx, 4xx) fails the save so a retry can never create a duplicate draft — the user clicks Save again. Updates (PUT) are retried normally.
- A save request older than 10 minutes (`SAVE_STALE_MS`) and a pending summary or draft older than 5 minutes (`PENDING_STALE_MS`) are treated as abandoned: they no longer block new requests and render as retryable.
- One in-flight summary and one in-flight generated draft per thread; repeated clicks while one is fresh are ignored (no duplicate paid calls).
- Reply recipients are validated strictly (ASCII local@domain); internationalised addresses are refused with 'There is no message from someone else to reply to.' rather than risk header injection.
- The reply MIME module is `packages/mail/src/mime/replyMime.ts` (not `reply.ts`) because the no-send guard rejects `/reply` paths.
- Deferred: a Redis outage at web cold start can still hang an enqueue until the 5-minute stale window; per-user rate limits on Summarize/Generate remain M6.
