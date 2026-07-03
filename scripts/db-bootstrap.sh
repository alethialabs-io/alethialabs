#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bring the local app database up and migrated, with zero manual steps.
# Idempotent and re-runnable: `pnpm db:up`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "✗ no .env found — run: cp .env.example .env" >&2
  exit 1
fi
set -a; source .env; set +a

echo "→ waiting for Docker daemon…"
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  if [[ $i -eq 60 ]]; then
    echo "✗ Docker daemon not responding after 60s — open Docker Desktop and retry." >&2
    exit 1
  fi
  sleep 1
done

echo "→ starting postgres…"
docker compose up -d postgres

echo "→ waiting for postgres to accept connections…"
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

echo "→ migrating…"
pnpm -C apps/console db:migrate

echo "✓ local database is up and migrated"
