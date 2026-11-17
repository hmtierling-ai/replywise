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
- `completeConnect` should enqueue `mailbox.sync`; `disconnectMailbox` should remove the mailbox's scheduled jobs
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
