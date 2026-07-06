#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Tear down the self-healing stitched stack started by `pnpm dev:stitch`: stop the
# respawn supervisors FIRST (so nothing restarts), then their children -- console,
# marketing, the microfrontends proxy, and cloudflared. Leaves the Docker backends
# (postgres/seaweedfs/openfga) and the runner running. One command: `pnpm dev:stitch:down`.
set -euo pipefail

CONSOLE_PORT="${CONSOLE_PORT:-3100}"
MARKETING_PORT="${MARKETING_PORT:-3010}"

stopped=0

# 1) Kill the supervisors first so killed children don't get respawned.
for name in console marketing proxy cloudflared; do
  pf="/tmp/alethia-sup-$name.pid"
  if [[ -f "$pf" ]]; then
    pid="$(cat "$pf" 2>/dev/null || echo)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && { echo "ok stopped supervisor: $name (pid $pid)"; stopped=$((stopped+1)); }
    rm -f "$pf"
  fi
done

# 2) Kill the children. Console/marketing by their LISTEN port (don't touch :3000/:3030
#    or other projects); proxy + cloudflared by command signature.
pkill -f 'scripts/dev-up.sh' 2>/dev/null || true
pkill -f 'stripe listen.*/api/webhooks/stripe' 2>/dev/null || true
lsof -ti tcp:"$CONSOLE_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null && { echo "ok stopped console :$CONSOLE_PORT"; stopped=$((stopped+1)); } || true
lsof -ti tcp:"$MARKETING_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null && { echo "ok stopped marketing :$MARKETING_PORT"; stopped=$((stopped+1)); } || true
pkill -f 'microfrontends proxy' 2>/dev/null && { echo "ok stopped proxy"; stopped=$((stopped+1)); } || true
pkill -f 'cloudflared tunnel' 2>/dev/null && { echo "ok stopped cloudflared"; stopped=$((stopped+1)); } || true

rm -rf /tmp/alethia-dev-console.lock /tmp/alethia-dev-marketing.lock

if (( stopped == 0 )); then
  echo "i nothing stitched was running."
else
  echo "ok stitched stack stopped. Backends + runner left running."
fi
