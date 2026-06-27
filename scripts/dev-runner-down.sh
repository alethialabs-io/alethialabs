#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Tear down the local runners started by `pnpm dev:runner`: stop native processes
# and/or remove docker containers, then free the lock. One command: `pnpm dev:runner:down`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCK=/tmp/alethia-dev-runner.lock
CONTAINER_PREFIX=alethia-runner
MODE="$(cat "$LOCK/mode" 2>/dev/null || echo "")"

stopped=0

# Native processes recorded under the lock dir (one pid per line).
if [[ "$MODE" != "docker" && -f "$LOCK/pids" ]]; then
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill "$pid" 2>/dev/null; then
      echo "✓ stopped runner pid $pid"; stopped=$((stopped+1))
    fi
  done < "$LOCK/pids"
fi

# Docker containers (also catch any left over even if the lock is gone).
for name in $(docker ps -aq --filter "name=${CONTAINER_PREFIX}-" 2>/dev/null); do
  docker rm -f "$name" >/dev/null 2>&1 && { echo "✓ removed container $name"; stopped=$((stopped+1)); }
done

rm -rf "$LOCK"

if (( stopped == 0 )); then
  echo "ℹ no local runners were running."
else
  echo "✓ tore down $stopped runner(s). The Fleet page will show them OFFLINE shortly."
fi
