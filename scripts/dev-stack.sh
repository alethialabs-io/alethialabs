#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Full platform, fully dockerized, hot reload. Every Next zone runs `next dev` in a
# container (source bind-mounted, polling watch), Caddy stitches them, a Cloudflare
# quick tunnel fronts the stitched site, and a Stripe CLI container forwards webhooks.
# One command:  pnpm dev:stack
#
# Watch logs:   pnpm dev:stack:logs      Tear down:  pnpm dev:stack:down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DC=(docker compose -f docker-compose.dev.yml)
ENV_LOCAL="apps/console/.env.local"
OPENFGA_URL="http://localhost:8082"
URL_FILE=/tmp/alethia-cf-url.txt
LOCK=/tmp/alethia-dev-stack.lock

if [[ ! -f .env ]]; then
  echo "✗ no .env found — run: cp .env.example .env" >&2
  exit 1
fi

# ── single stack across windows ──
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ "${FORCE:-}" = "1" ]; then
    echo "↻ FORCE=1 — reclaiming dev-stack lock…"; rm -rf "$LOCK"; mkdir "$LOCK"
  else
    echo "⏳ dev:stack already provisioning (lock held). Logs: pnpm dev:stack:logs  ·  Restart: FORCE=1 pnpm dev:stack"
    exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

echo "→ waiting for Docker daemon…"
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; [[ $i -eq 60 ]] && { echo "✗ Docker not responding." >&2; exit 1; }; sleep 1; done

# Load .env (STRIPE_SECRET_KEY, DB creds, etc.) into the shell so compose interpolates.
set -a; source ./.env; set +a

# Build the dev image only when missing (or REBUILD=1 — e.g. after a deps change).
# Plain `docker build` (single-arch, --provenance=false) keeps it lean — `compose build`
# defaults to a multi-arch + attestation image that's ~2× the size.
if [ "${REBUILD:-}" = "1" ] || ! docker image inspect alethia-dev >/dev/null 2>&1; then
  echo "→ building the dev image (alethia-dev)…"
  DOCKER_BUILDKIT=1 docker build --provenance=false -f Dockerfile.dev -t alethia-dev .
else
  echo "→ reusing the dev image (alethia-dev). Rebuild after deps change: REBUILD=1 pnpm dev:stack"
fi

echo "→ starting backends (postgres, seaweedfs, openfga)…"
"${DC[@]}" up -d postgres seaweedfs openfga

echo "→ waiting for postgres…"
for i in $(seq 1 60); do
  "${DC[@]}" exec -T postgres pg_isready -U "${ALETHIA_DB_USER:-alethia}" -d "${ALETHIA_DB_NAME:-alethia}" >/dev/null 2>&1 && break
  [[ $i -eq 60 ]] && { echo "✗ postgres not ready." >&2; "${DC[@]}" logs --tail=30 postgres >&2; exit 1; }
  sleep 1
done

echo "→ migrating app database…"
"${DC[@]}" run --rm migrate

echo "→ waiting for OpenFGA…"
for i in $(seq 1 60); do curl -fs "$OPENFGA_URL/healthz" >/dev/null 2>&1 && break; [[ $i -eq 60 ]] && { echo "✗ OpenFGA not ready." >&2; "${DC[@]}" logs --tail=30 openfga >&2; exit 1; }; sleep 1; done

# Reuse / create the OpenFGA store (persisted to .env.local; the app writes the model on boot).
STORE_ID=""
[[ -f "$ENV_LOCAL" ]] && STORE_ID="$(grep -E '^OPENFGA_STORE_ID=' "$ENV_LOCAL" | head -1 | cut -d= -f2- || true)"
if [[ -n "$STORE_ID" ]] && curl -fs "$OPENFGA_URL/stores/$STORE_ID" >/dev/null 2>&1; then
  echo "→ reusing OpenFGA store $STORE_ID"
else
  echo "→ creating OpenFGA store…"
  RESP="$(curl -fsS -X POST "$OPENFGA_URL/stores" -H 'content-type: application/json' -d '{"name":"alethia-dev"}')"
  STORE_ID="$(printf '%s' "$RESP" | grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')"
  [[ -z "$STORE_ID" ]] && { echo "✗ could not create OpenFGA store: $RESP" >&2; exit 1; }
  touch "$ENV_LOCAL"; grep -vE '^(OPENFGA_API_URL|OPENFGA_STORE_ID)=' "$ENV_LOCAL" > "$ENV_LOCAL.tmp" || true
  { echo "OPENFGA_API_URL=$OPENFGA_URL"; echo "OPENFGA_STORE_ID=$STORE_ID"; } >> "$ENV_LOCAL.tmp"; mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"
  echo "  created store $STORE_ID"
fi
export OPENFGA_STORE_ID="$STORE_ID"

echo "→ starting zones (console, marketing, docs, blog) + caddy…"
"${DC[@]}" up -d app marketing docs blog caddy

echo "→ starting Cloudflare tunnel…"
"${DC[@]}" up -d cloudflared

# Capture the quick-tunnel URL from cloudflared's logs.
PUBLIC_URL=""
for _ in $(seq 1 40); do
  PUBLIC_URL="$("${DC[@]}" logs cloudflared 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break; sleep 1
done
[[ -z "$PUBLIC_URL" ]] && { echo "✗ no tunnel URL after 40s." >&2; "${DC[@]}" logs --tail=20 cloudflared >&2; exit 1; }
printf '%s\n' "$PUBLIC_URL" > "$URL_FILE"
export ALETHIA_PUBLIC_URL="$PUBLIC_URL"

# Stripe webhooks (best-effort): start the listener container, read ITS signing secret
# from the logs, and inject it into the console.
if [[ -n "${STRIPE_SECRET_KEY:-}" ]]; then
  echo "→ starting Stripe webhook listener…"
  "${DC[@]}" up -d stripe
  WHSEC=""
  for _ in $(seq 1 30); do
    WHSEC="$("${DC[@]}" logs stripe 2>/dev/null | grep -oE 'whsec_[A-Za-z0-9]+' | head -1 || true)"
    [[ -n "$WHSEC" ]] && break; sleep 1
  done
  if [[ -n "$WHSEC" ]]; then export STRIPE_WEBHOOK_SECRET="$WHSEC"; echo "  webhooks → /api/webhooks/stripe"; else
    echo "⚠ couldn't read the Stripe listen secret — webhook signatures may fail."; fi
fi

# Re-create the auth-bearing zones with the public origin (+ Stripe secret) now known.
echo "→ binding auth origin to $PUBLIC_URL …"
"${DC[@]}" up -d --no-deps --force-recreate app marketing

echo ""
echo "✓ dev:stack up — open:  $PUBLIC_URL"
echo "  Login:  $PUBLIC_URL/login   (email-OTP)   ·   Docs: $PUBLIC_URL/docs"
echo "  Logs:   pnpm dev:stack:logs    ·    Down:  pnpm dev:stack:down"
