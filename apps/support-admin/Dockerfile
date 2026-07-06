# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Support-admin (internal staff Next.js dashboard) self-host image. Build context = repo root:
#   docker build -f apps/support-admin/Dockerfile -t alethia-support-admin .
#
# Runs on its OWN subdomain behind CLOUDFLARE ACCESS (like the Umami dashboard) — the app
# trusts the Cf-Access-Authenticated-User-Email header + the SUPPORT_STAFF_EMAILS allowlist.
# Listens on :3000 in-container (the compose/Caddy map fronts it). Reads the same Postgres
# as the console via ALETHIA_DATABASE_URL.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install workspace deps (incl. @repo/{ui,brand,email,support}) + build ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter support-admin...
RUN pnpm --filter support-admin build

# ---- runner: slim standalone runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/apps/support-admin/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/support-admin/.next/static ./apps/support-admin/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/support-admin/public ./apps/support-admin/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/support-admin/server.js"]
