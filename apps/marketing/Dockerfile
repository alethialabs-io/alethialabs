# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Marketing (Next.js public site) self-host image. Build context = repo root:
#   docker build -f apps/marketing/Dockerfile -t alethia-marketing .
#
# The hosted alethialabs.io site runs on Vercel (microfrontends child zone); this
# image is the OPT-IN self-host path, stitched behind Caddy next to the console
# (see deploy/caddy/marketing.caddy.example). Listens on :3000 to match that map.
# Owns the bare root `/`; serves its own assets under the `/mkt-assets` prefix.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install workspace deps (incl. @repo/{ui,brand,plan-catalog}) + build ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter marketing...
# Stripe drives the live pricing label but falls back to the static plan-catalog,
# so the build needs no secrets. Public flags Next inlines stay at their defaults.
RUN pnpm --filter marketing build

# ---- runner: slim standalone runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/apps/marketing/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/marketing/.next/static ./apps/marketing/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/marketing/public ./apps/marketing/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/marketing/server.js"]
