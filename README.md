# Replywise

AI email assistant: classifies, summarizes and drafts replies into your Gmail/Outlook drafts. Never sends email.

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
