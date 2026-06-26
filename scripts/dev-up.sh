#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Full local dev with hot reload: backends in Docker (Postgres + SeaweedFS +
# OpenFGA), console run natively via `next dev`. One command: `pnpm dev:up`.
#
# Why this exists: Next.js `dev` reads apps/console/.env (a stale file), never the
# monorepo-root .env (the real dev env). This script sources the root .env into the
# console process, points OpenFGA at localhost (the root .env uses the docker host),
# and auto-provisions an OpenFGA store — the app writes the model + tuples on boot.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_LOCAL="apps/console/.env.local"
OPENFGA_URL="http://localhost:8082"
LOCK=/tmp/alethia-dev-console.lock
DEV_LOG=/tmp/alethia-dev-console.log
DEV_URL="http://localhost:3000"

if [[ ! -f .env ]]; then
  echo "✗ no .env found — run: cp .env.example .env" >&2
  exit 1
fi

# ── One shared console across windows/worktrees (mirrors scripts/compose-up.sh) ──
# next dev binds :3000; running it twice races the port + env. A second `pnpm dev:up`
# no-ops and points you at the running one. FORCE=1 reclaims the lock and restarts.
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || echo "")"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    if [ "${FORCE:-}" = "1" ]; then
      echo "↻ FORCE=1 — stopping existing console (pid $holder)…"
      kill "$holder" 2>/dev/null || true
      lsof -ti tcp:3000 2>/dev/null | xargs kill 2>/dev/null || true
      sleep 1; rm -rf "$LOCK"; mkdir "$LOCK"
    else
      echo "⏳ Console already running (pid $holder) at $DEV_URL — not starting a duplicate."
      echo "   Follow logs:  pnpm dev:logs   ·   Restart: FORCE=1 pnpm dev:up"
      exit 0
    fi
  else
    echo "↻ Reclaiming stale console lock (holder pid '${holder:-?}' is gone)."
    rm -rf "$LOCK"; mkdir "$LOCK"
  fi
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# Refuse to clobber a console started outside this script (lock just taken → trap frees it).
if [ "${FORCE:-}" != "1" ] && lsof -ti tcp:3000 >/dev/null 2>&1; then
  echo "⏳ :3000 already in use — assuming the console is up. Logs: pnpm dev:logs  (take over: FORCE=1 pnpm dev:up)"
  exit 0
fi

echo "→ waiting for Docker daemon…"
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  if [[ $i -eq 60 ]]; then
    echo "✗ Docker daemon not responding after 60s — open Docker Desktop and retry." >&2
    exit 1
  fi
  sleep 1
done

# Load the canonical dev env (DB → localhost:5433, storage → localhost:8333,
# BETTER_AUTH_SECRET, ngrok URLs). OpenFGA gets overridden to localhost below.
set -a
# shellcheck disable=SC1091
source ./.env
set +a

# Front the console at a public tunnel origin (ngrok / cloudflare). When
# ALETHIA_PUBLIC_URL is exported by the caller (e.g. scripts/cf-tunnel.sh), it
# overrides the .env auth base URLs so a browser on that origin is same-origin
# with Better Auth (client baseURL + server trustedOrigins). Survives the source
# above because nothing in .env sets ALETHIA_PUBLIC_URL.
if [[ -n "${ALETHIA_PUBLIC_URL:-}" ]]; then
  export NEXT_PUBLIC_APP_URL="$ALETHIA_PUBLIC_URL"
  export BETTER_AUTH_URL="$ALETHIA_PUBLIC_URL"
  echo "→ public origin override: $ALETHIA_PUBLIC_URL"
fi

echo "→ starting postgres, seaweedfs, openfga…"
docker compose --profile enterprise up -d postgres seaweedfs openfga

echo "→ waiting for postgres…"
for i in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U "${ALETHIA_DB_USER:-alethia}" -d "${ALETHIA_DB_NAME:-alethia}" >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "✗ postgres not ready after 60s." >&2
    docker compose logs --tail=30 postgres >&2 || true
    exit 1
  fi
  sleep 1
done

echo "→ migrating app database…"
pnpm -C apps/console db:migrate

echo "→ waiting for OpenFGA…"
for i in $(seq 1 60); do
  if curl -fs "$OPENFGA_URL/healthz" >/dev/null 2>&1; then break; fi
  if [[ $i -eq 60 ]]; then
    echo "✗ OpenFGA not ready after 60s." >&2
    docker compose logs --tail=30 openfga >&2 || true
    exit 1
  fi
  sleep 1
done

# Ensure an OpenFGA store exists (idempotent). The store id is persisted to
# apps/console/.env.local so restarts reuse it; the app writes the model + tuples
# into it on boot (instrumentation.ts → tuple-sync backfill).
STORE_ID=""
if [[ -f "$ENV_LOCAL" ]]; then
  STORE_ID="$(grep -E '^OPENFGA_STORE_ID=' "$ENV_LOCAL" | head -1 | cut -d= -f2- || true)"
fi

if [[ -n "$STORE_ID" ]] && curl -fs "$OPENFGA_URL/stores/$STORE_ID" >/dev/null 2>&1; then
  echo "→ reusing OpenFGA store $STORE_ID"
else
  echo "→ creating OpenFGA store…"
  RESP="$(curl -fsS -X POST "$OPENFGA_URL/stores" -H 'content-type: application/json' -d '{"name":"alethia-dev"}')"
  STORE_ID="$(printf '%s' "$RESP" | grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')"
  if [[ -z "$STORE_ID" ]]; then
    echo "✗ could not create OpenFGA store. Response: $RESP" >&2
    exit 1
  fi
  touch "$ENV_LOCAL"
  grep -vE '^(OPENFGA_API_URL|OPENFGA_STORE_ID)=' "$ENV_LOCAL" > "$ENV_LOCAL.tmp" || true
  {
    echo "OPENFGA_API_URL=$OPENFGA_URL"
    echo "OPENFGA_STORE_ID=$STORE_ID"
  } >> "$ENV_LOCAL.tmp"
  mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"
  echo "  created store $STORE_ID (saved to $ENV_LOCAL)"
fi

# Point the console at the local OpenFGA (root .env uses the docker host).
export OPENFGA_API_URL="$OPENFGA_URL"
export OPENFGA_STORE_ID="$STORE_ID"

echo "✓ backends up — console hot-reloading on $DEV_URL  (logs: pnpm dev:logs)"
# No exec: keep this script as the parent so the EXIT trap frees the lock when the
# server stops, and tee output to a shared logfile other windows can tail.
pnpm -C apps/console dev 2>&1 | tee "$DEV_LOG"
