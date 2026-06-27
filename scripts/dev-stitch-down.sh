#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OU <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Tear down the stitched extras started by `pnpm dev:stitch`: marketing dev server,
# the microfrontends proxy, and cloudflared. Leaves the console + backends (and the
# runner) running. One command: `pnpm dev:stitch:down`.
set -euo pipefail

MKT_LOCK=/tmp/alethia-dev-marketing.lock
PROXY_PIDF=/tmp/alethia-mfe-proxy.pid

stopped=0

# Marketing
if [[ -f "$MKT_LOCK/pid" ]]; then
  pid="$(cat "$MKT_LOCK/pid" 2>/dev/null || echo)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && { echo "ok stopped marketing (pid $pid)"; stopped=$((stopped+1)); }
fi
# next dev for marketing leaves a child; sweep by port-owner too.
lsof -ti tcp:3010 2>/dev/null | xargs kill 2>/dev/null && stopped=$((stopped+1)) || true
rm -rf "$MKT_LOCK"

# Microfrontends proxy
if [[ -f "$PROXY_PIDF" ]]; then
  pid="$(cat "$PROXY_PIDF" 2>/dev/null || echo)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && { echo "ok stopped proxy (pid $pid)"; stopped=$((stopped+1)); }
  rm -f "$PROXY_PIDF"
fi
pkill -f 'microfrontends proxy' 2>/dev/null && stopped=$((stopped+1)) || true

# Tunnel
pkill -f 'cloudflared tunnel' 2>/dev/null && { echo "ok stopped cloudflared"; stopped=$((stopped+1)); } || true

if (( stopped == 0 )); then
  echo "i nothing stitched was running."
else
  echo "ok torn down stitched extras. Console + backends + runner left running."
fi
