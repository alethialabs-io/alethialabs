# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Console (Next.js) self-host image. Build context = repo root:
#   docker build -f apps/console/Dockerfile -t alethia-console .
#
# Targets:
#   build   — full monorepo install + `next build` (also used for the one-shot
#             `migrate` service, which needs the drizzle migrator + lib/db).
#   runner  — slim Next standalone runtime (default).

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install workspace deps + produce the standalone bundle ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter console...
RUN pnpm --filter console build

# ---- migrate: one-shot DB migrate (drizzle migrator lives in full node_modules) ----
FROM build AS migrate
WORKDIR /app/apps/console
CMD ["node", "scripts/migrate.mjs"]

# ---- runner: slim standalone runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/apps/console/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/console/public ./apps/console/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/console/server.js"]
