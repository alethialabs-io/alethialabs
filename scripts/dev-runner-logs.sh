#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Follow the logs of the local runners started by `pnpm dev:runner`, auto-detecting
# native (tee'd logfiles) vs docker (container logs). One command: `pnpm dev:runner:logs`.
set -euo pipefail

LOCK=/tmp/alethia-dev-runner.lock
CONTAINER_PREFIX=alethia-runner
LOG_PREFIX=/tmp/alethia-dev-runner
MODE="$(cat "$LOCK/mode" 2>/dev/null || echo "")"

if [[ "$MODE" == "docker" ]]; then
  names=()
  while IFS= read -r n; do [[ -n "$n" ]] && names+=("$n"); done \
    < <(docker ps --filter "name=${CONTAINER_PREFIX}-" --format '{{.Names}}' 2>/dev/null)
  if (( ${#names[@]} == 0 )); then
    echo "ℹ no runner containers running — start them: pnpm dev:runner" >&2
    exit 0
  fi
  if (( ${#names[@]} == 1 )); then
    exec docker logs --tail=100 -f "${names[0]}"
  fi
  # `docker logs -f` takes one container — fan out, prefixing each line, stop all on Ctrl-C.
  trap 'kill 0' INT TERM
  for n in "${names[@]}"; do
    docker logs --tail=100 -f "$n" 2>&1 | sed "s/^/[$n] /" &
  done
  wait
fi

# Native: tail the per-runner logfiles.
shopt -s nullglob
files=( "${LOG_PREFIX}"-*.log )
if (( ${#files[@]} == 0 )); then
  echo "ℹ no runner logs found — start them: pnpm dev:runner" >&2
  exit 0
fi
exec tail -n 100 -f "${files[@]}"
