#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs ON the box. Brings up the SHARED tier (Postgres + OpenFGA) that every branch
# environment uses, from the pinned compose file at /opt/alethia/shared/.
#
# Envs must never run `docker compose` themselves — see the long comment in
# shared-compose.yml for why (branch-dependent re-convergence of everyone's
# containers). This script is the only thing that touches the shared tier.
set -euo pipefail

SHARED=/opt/alethia/shared
COMPOSE=(docker compose -f "$SHARED/docker-compose.yml")

echo "→ shared tier: postgres + openfga"
"${COMPOSE[@]}" up -d --wait postgres openfga

# --wait covers the healthchecks, but OpenFGA's HTTP API answers slightly after the
# container reports healthy; env-mode.sh creates a store immediately after this.
for _ in $(seq 1 60); do
  if curl -fs http://localhost:8082/healthz >/dev/null 2>&1; then
    echo "✓ shared tier ready (postgres :5433, openfga :8082)"
    exit 0
  fi
  sleep 1
done

echo "✗ OpenFGA did not answer on :8082 within 60s" >&2
"${COMPOSE[@]}" logs --tail=30 openfga >&2 || true
exit 1
