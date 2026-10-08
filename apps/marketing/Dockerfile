# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Marketing (Next.js public site) self-host image. Build context = repo root:
#   docker build -f apps/marketing/Dockerfile -t alethia-marketing .
#
# The hosted alethialabs.io site runs from this image in the Hetzner production
# Compose stack. Self-hosters can opt into the same image and stitch it behind
# Caddy next to the console (see deploy/caddy/marketing.caddy.example).
# Owns the bare root `/`; serves its own assets under the `/mkt-assets` prefix.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install workspace deps (incl. @repo/{ui,brand,plan-catalog}) + build ----
FROM base AS build
ARG VERSION=development
ARG ALETHIA_CORE_SOURCE_URL=https://github.com/alethialabs-io/alethialabs
ENV ALETHIA_SOURCE_COMMIT=$VERSION
ENV ALETHIA_CORE_SOURCE_URL=$ALETHIA_CORE_SOURCE_URL
COPY . .
RUN pnpm install --frozen-lockfile --filter marketing...
# Stripe drives the live pricing label but falls back to the static plan-catalog,
# so the build needs no secrets. Public flags Next inlines stay at their defaults.
RUN pnpm --filter marketing build

# ---- runner: slim standalone runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
# Build args are scoped per stage, so VERSION is redeclared here. NEXT_PUBLIC_APP_VERSION must be set
# in THIS stage: next-runtime-env's <PublicEnvScript /> (app/layout.tsx) serialises the RUNNING
# server's process.env into window.__ENV, and the post-deploy smoke's `marketing-build-id` check reads
# it there (#5697, mirroring the console's runner stage, #5621). ALETHIA_SOURCE_COMMIT is repeated so
# the running container — not just the build stage — names the commit it was built from.
# apps/console/tests/unit/dockerfile-runtime-public-env.test.ts fails if either line goes.
ARG VERSION=development
ENV NODE_ENV=production \
    ALETHIA_SOURCE_COMMIT=$VERSION \
    NEXT_PUBLIC_APP_VERSION=$VERSION
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/apps/marketing/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/marketing/.next/static ./apps/marketing/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/marketing/public ./apps/marketing/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/marketing/server.js"]
