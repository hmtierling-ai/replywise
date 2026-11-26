# Replywise

AI email assistant: classifies, summarizes and drafts replies into your Gmail/Outlook drafts. Never sends email without your confirmation.

Design: `docs/superpowers/specs/2026-11-15-replywise-design.md`

## Local development

Requirements: Node 22+ (24 recommended, see `.nvmrc`), pnpm 11, Docker.

```bash
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

## Deployment

Two images, one Postgres (≥16), one Redis:

| Image | Build | Run |
|---|---|---|
| web | `docker build -f apps/web/Dockerfile .` | `node apps/web/server.js` (port 3000) |
| worker | `docker build -f apps/worker/Dockerfile .` | `node apps/worker/dist/index.js` |

Release step before starting new versions: `node apps/worker/dist/migrate.js` (worker image).
Required env: see `.env.example`. In production `LOCAL_KEKS` is replaced by a KMS key provider (milestone M6).

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

## Syncing mail in development

The worker syncs every active Gmail mailbox: the last 30 days of inbox threads on the first run,
then changes every 2 minutes (schedules are reconciled once a minute, so a new mailbox starts
within about a minute of connecting). Gmail calls are paced by quota cost (`GMAIL_COST`, about
90 units/s against Gmail's 6000 units/min per-user limit; a full thread fetch costs ~120), so the
first sync of a large inbox takes several minutes; threads appear in batches as they are saved.

```bash
docker compose up -d --wait
pnpm db:migrate
pnpm --filter @replywise/worker dev   # terminal 1 — needs GMAIL_CLIENT_ID/SECRET in .env to refresh tokens
pnpm --filter @replywise/web dev      # terminal 2
```

Message bodies are cached encrypted for `body_cache_days` (default 14) and refetched on demand
when you open an older thread. Replywise reads your mail and saves drafts; it never sends email without your confirmation.

## AI classification

Add your own Anthropic API key in **Settings → AI**. Replywise checks it against the Anthropic API, stores it encrypted, and shows only its last four characters.

The worker scans every minute for inbox threads whose newest message arrived in the last 7 days and isn't yours. It classifies each one once per new message with your key: urgency and importance from 1 to 5, whether it needs a reply, and up to three plain-text reasons. The thread then appears under Urgent, Important, Needs Reply, Informational or Low Priority.

- Default model: Claude Opus 5.5 (low effort). Claude Haiku 5.5 is available in Settings for much lower cost.
- Usage per task and model, with an estimate, is shown in Settings → AI.
- A rejected key pauses classification until you replace it.
- Email content is sent to Anthropic only for classification, as untrusted data with no tools; Replywise never sends email without your confirmation.

The worker needs no extra environment variables; keys are per user.

## Summaries and reply drafts

Open a thread and click **Summarize** for a short AI summary, or choose a tone, add optional instructions and click **Generate reply**. Edit the reply, **Regenerate** it, and click **Save to Gmail**: Replywise creates (or updates) a draft in the same Gmail conversation, with your signature appended. You can also send the reply from Replywise (see below).

- Writing preferences (default tone, reply model, signature, style notes, reply language) live in Settings → AI.
- Settings → Mailboxes has an optional per-mailbox **auto-draft for Needs Reply** (off by default): Replywise writes a draft in the app with your key for Needs Reply mail from the last 7 days, including when classification first runs; it reaches Gmail only when you click Save.
- Summaries and replies run in the worker with your key (Opus 5.5 at medium effort by default; Haiku 5.5 is cheaper). Usage appears in Settings → AI.

## Sending replies, Sent, Other and search

- **Send (Gmail only).** Under a draft, click **Send…**. The dialog shows the recipient, the subject and the start of the reply; **Send now** waits 10 seconds with an **Undo** button, then Replywise saves the Gmail draft and sends it with Gmail's send-draft call. Nothing is ever sent without that click: AI jobs and auto-draft never send. At most 20 sends per hour. If Gmail's answer is lost (timeout, 5xx), the reply is marked "may or may not have gone out" and is never retried automatically — check Gmail's Sent folder, then choose **Edit**.
- **Sent.** Sync now brings in the last 30 days of Inbox **and** Sent; the **Sent** view lists conversations you wrote in.
- **Other.** Gmail's Promotions, Social and Updates mail you never replied to is kept out of All mail and the AI tabs, is never auto-classified, and is listed under **Other** (with tab filters).
- **Search.** Press `/` (or use the box above the list) to search subjects, senders and previews of everything synced. **Search all of Gmail** runs your query (Gmail syntax) against the mailbox and lets you **Import** an older thread. Message bodies are not searched locally.

No new Google scope is needed: `gmail.compose` already allows sending drafts.
