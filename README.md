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
