#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs ON the box. Brings ONE branch environment up.
#
#   env-mode.sh <slug> <consolePort> <storagePort> <database> [fresh]
#
# Deliberately outside cloud-init: `env:up` rsyncs it every time, so changing how an
# env boots never means rebuilding a box.
#
# Environments are PEERS, not tenants. Each gets its own tree (/opt/alethia/envs/<slug>),
# its own database, its own OpenFGA store, its own SeaweedFS container and its own
# console port — but they SHARE one Postgres and one OpenFGA, because those isolate
# logically and a container set per env would spend the box's 16 GB on nothing.
#
# SeaweedFS is the exception and it is not a style choice: bucket names are hardcoded
# constants in the app (apps/console/lib/storage/plan-artifact.ts:9 "plan-artifacts",
# tofu-state.ts:15 "project-tofu-state") with no env-driven prefix, so one shared
# SeaweedFS would collide OpenTofu STATE between branches. Per-env container it is.
set -euo pipefail

SLUG="${1:?slug}"
CPORT="${2:?console port}"
SPORT="${3:?storage port}"
DB="${4:?database}"
FRESH="${5:-}"

# shellcheck disable=SC1091
[ -f /opt/alethia/box.env ] && . /opt/alethia/box.env
DOMAIN="${ALETHIA_ENV_DOMAIN:?ALETHIA_ENV_DOMAIN missing from /opt/alethia/box.env}"

REPO="/opt/alethia/envs/$SLUG"
LOG="/var/log/alethia-$SLUG.log"
SESSION="alethia-$SLUG"
SEAWEED="alethia-seaweed-$SLUG"
SHARED_COMPOSE=(docker compose -f /opt/alethia/shared/docker-compose.yml)
# The hostname belongs to the SLOT, not the branch — the same mapping env_fqdn() applies
# in scripts/env.sh, derived from the console port the registry allocated:
# 3100 -> env1-, 3200 -> env2-. `dev` keeps the bare domain (OAuth redirect URIs and the
# Stripe webhook are registered against exactly that name and cannot be wildcarded).
#
# This built "$SLUG.$DOMAIN" until 2026-07-30. That is TWO labels deep, outside
# Cloudflare's Universal SSL, and once the `*.dev` wildcard was removed it stopped
# resolving at all — so `env:up` finished by printing a URL that no longer existed, which
# is worse than printing nothing. The minted .env was always correct; only this line lied.
#
# It survived the slot-hostname change because it is a SECOND, independent construction of
# the same hostname: that change updated env.sh and env-tunnel.sh and claimed env_fqdn was
# the only place a hostname is built. Grep before believing that kind of claim.
if [ "$SLUG" = "dev" ]; then
  FQDN="$DOMAIN"
else
  FQDN="env$(((CPORT - 3000) / 100))-$DOMAIN"
fi
URL="https://$FQDN"

cd "$REPO"
export PATH="$PATH:/usr/local/go/bin"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

psql_su() { "${SHARED_COMPOSE[@]}" exec -T postgres psql -U alethia -v ON_ERROR_STOP=1 "$@"; }

# ── Database ─────────────────────────────────────────────────────────────────────
if [ "$FRESH" = "fresh" ]; then
  log "--fresh: dropping database $DB"
  # WITH (FORCE) so a leftover `next dev` connection cannot hold the drop hostage;
  # the point of --fresh is that it always works.
  psql_su -d alethia -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)"
fi

if [ "$(psql_su -d alethia -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | tr -d '[:space:]')" != "1" ]; then
  log "Creating database $DB"
  psql_su -d alethia -c "CREATE DATABASE \"$DB\" OWNER alethia"
fi

# ── Per-env object storage ───────────────────────────────────────────────────────
# Bound to loopback like the shared tier. `-ip.bind=0.0.0.0` is the container's own
# interface binding (the healthcheck needs it); the published port is still local.
if ! docker ps --format '{{.Names}}' | grep -qx "$SEAWEED"; then
  log "Starting SeaweedFS for $SLUG on :$SPORT"
  docker rm -f "$SEAWEED" >/dev/null 2>&1 || true
  docker run -d --name "$SEAWEED" --restart unless-stopped \
    -p "127.0.0.1:$SPORT:8333" \
    -v "alethia-seaweed-$SLUG:/data" \
    -v "$REPO/deploy/seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro" \
    --memory 512m \
    chrislusf/seaweedfs:latest \
    server -dir=/data -s3 -s3.config=/etc/seaweedfs/s3.json \
    -master.volumeSizeLimitMB=1024 -ip.bind=0.0.0.0 >/dev/null
fi

# ── Dependencies ─────────────────────────────────────────────────────────────────
log "Installing dependencies"
pnpm install --frozen-lockfile

# @alethia/ee ships as a workspace package whose dist a fresh tree links but never
# builds; without it loadEnterprise() throws, getAuthPlugins() returns [], and
# /api/auth/organization/* 404s. Same reasoning as scripts/dev-up.sh:116.
if [ -f ee/package.json ] && [ ! -f ee/dist/index.js ]; then
  log "Building @alethia/ee"
  pnpm -F @alethia/ee build
fi

# ── Schema ───────────────────────────────────────────────────────────────────────
log "Migrating $DB"
set -a
# shellcheck disable=SC1091
. "$REPO/.env"
set +a
pnpm -C apps/console db:migrate

# ── OpenFGA store (one per env, on the shared server) ────────────────────────────
# Mirrors scripts/dev-up.sh:132-158. The app writes the model + tuples into the store
# on boot (instrumentation.ts -> tuple-sync backfill); this only has to make it exist.
STORE_ID="$(grep -E '^OPENFGA_STORE_ID=' apps/console/.env.local 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ -n "$STORE_ID" ] && curl -fs "http://localhost:8082/stores/$STORE_ID" >/dev/null 2>&1; then
  log "Reusing OpenFGA store $STORE_ID"
else
  log "Creating OpenFGA store for $SLUG"
  RESP="$(curl -fsS -X POST http://localhost:8082/stores \
    -H 'content-type: application/json' -d "{\"name\":\"alethia-$SLUG\"}")"
  STORE_ID="$(printf '%s' "$RESP" | jq -r '.id')"
  [ -n "$STORE_ID" ] && [ "$STORE_ID" != "null" ] || {
    echo "✗ could not create OpenFGA store. Response: $RESP" >&2
    exit 1
  }
  printf 'OPENFGA_API_URL=http://localhost:8082\nOPENFGA_STORE_ID=%s\n' "$STORE_ID" >apps/console/.env.local
  echo "  created store $STORE_ID"
fi
/opt/alethia/bin/env-registry.sh store "$SLUG" "$STORE_ID"

# ── Tunnel ───────────────────────────────────────────────────────────────────────
log "Cloudflare tunnel"
/opt/alethia/bin/env-tunnel.sh

# ── The dev server ───────────────────────────────────────────────────────────────
# tmux, not systemd: an environment is something you attach to and watch.
# `tmux attach -t alethia-<slug>` after an ssh gives you that branch's dev server log,
# which is most of why you would be on this box at all. One session per environment,
# so restarting yours never touches anyone else's.
#
# NODE_OPTIONS caps the heap: nothing in either repo compose file declares a limit,
# and on a shared box one runaway Turbopack compile OOM-kills its neighbours.
log "Starting console on :$CPORT"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new -d -s "$SESSION" \
  "cd $REPO && set -a && . $REPO/.env && set +a && \
   PORT=$CPORT NODE_OPTIONS=--max-old-space-size=3072 \
   pnpm -C apps/console dev 2>&1 | tee $LOG"

log "Waiting for :$CPORT"
for _ in $(seq 1 150); do
  if curl -fsS -o /dev/null "http://localhost:$CPORT/api/health" 2>/dev/null ||
    curl -fsS -o /dev/null "http://localhost:$CPORT/login" 2>/dev/null; then
    echo
    echo "  ✓ $SLUG is up   $URL"
    echo "    logs:  pnpm env:logs        (sign-in codes are printed here)"
    exit 0
  fi
  sleep 2
done

echo "✗ $SLUG did not answer on :$CPORT within 5 min — check: tmux attach -t $SESSION" >&2
exit 1
