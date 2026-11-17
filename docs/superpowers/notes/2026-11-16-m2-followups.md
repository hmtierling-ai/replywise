# M2 follow-ups (from task and final reviews)

Source: subagent-driven execution of `docs/superpowers/plans/2026-11-16-m2-mailbox-connection.md`.
The final whole-branch review verdict was "ready to merge with fixes"; the fixes landed in `200fd23`.

## Before merging M2

- Manual verification with a real Gmail account (and Outlook if configured): connect, reconnect, disconnect;
  confirm `tokens_ciphertext` holds no plaintext, Google's third-party access list no longer shows the app after
  disconnect, and `audit_logs` records the actions (plan Task 11, Step 3).
- While doing it, confirm the native connect form still reaches Google with CSP `form-action 'self'`
  (the hydrated path is covered by e2e).

## Carry into the M3 (sync) plan

- `getValidAccessToken` takes `SELECT … FOR UPDATE` even when the token is fresh. Add an unlocked fast path
  (lock and re-check only near expiry) and never call it inside an open transaction on the same mailbox row,
  or the sync job will self-deadlock.
- A successful refresh sets `status: "active"` and clears `last_error`; only reset when the status was
  `needs_reauth`, so sync errors are not clobbered.
- `completeConnect` should enqueue `mailbox.sync`; `disconnectMailbox` should remove the mailbox's scheduled jobs
  (spec §5, deliberately out of M2 scope).
- Extend the no-send guard to `apps/worker/src` once it makes Gmail/Graph data calls.
- Test gaps: refresh failing with a non-`invalid_grant` error leaves state unchanged; cross-user disconnect makes
  no revoke call and writes no audit row; `missing_refresh_token`; `startConnect` row has the expected
  `userId`/`provider`/`stateHash`; Outlook granted-scope contents; callback happy path against a stub token server.
- UX: the inbox empty state still says "No mailboxes connected" after a mailbox is connected.

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
