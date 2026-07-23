# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Docs (Next.js + Fumadocs) self-host image. Build context = repo root:
#   docker build -f apps/docs/Dockerfile -t alethia-docs .
# Stateless — serves the prebuilt MDX site at basePath /docs.

FROM node:26-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install + `next build` (fumadocs-mdx generates content on install) ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter docs...
RUN pnpm --filter docs build

# ---- runner: slim standalone runtime ----
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/apps/docs/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/docs/public ./apps/docs/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/docs/server.js"]
