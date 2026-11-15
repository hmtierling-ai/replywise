# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx --yes turbo@2 prune @replywise/worker --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@replywise/worker

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app ./
# dist/*.js resolves ../migrations relative to itself
COPY --from=builder --chown=app:app /app/packages/db/migrations ./apps/worker/migrations
USER app
CMD ["node", "apps/worker/dist/index.js"]
