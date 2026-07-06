# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Blog (Next.js + velite) self-host image. Build context = repo root:
#   docker build -f apps/blog/Dockerfile -t alethia-blog .
# Stateless — serves the prebuilt MDX blog at basePath /blog.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install + `velite && next build` (velite runs from the build script) ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter blog...
RUN pnpm --filter blog build

# ---- runner: slim standalone runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/apps/blog/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/blog/.next/static ./apps/blog/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/blog/public ./apps/blog/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/blog/server.js"]
