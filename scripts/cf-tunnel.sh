#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Expose the stitched dev site (microfrontends proxy on :3024) over a Cloudflare
# quick tunnel — no interstitial, no bandwidth throttle (unlike ngrok-free) — and
# re-point the console's auth origin at the tunnel URL so sign-in is same-origin.
#
#   pnpm dev:tunnel            # tunnels :3024 (the proxy)
#   pnpm dev:tunnel 3000       # tunnel a different local port
#
# Quick-tunnel URLs are random per run. The URL is printed + saved to
# /tmp/alethia-cf-url.txt. Requires the stitched stack already up (pnpm dev:up +
# marketing + proxy). For a STABLE url + working social OAuth, use a named tunnel
# to a real hostname instead (cloudflared tunnel login + DNS route).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${1:-3024}"
# Port the console actually runs on (the one to kill + restart). Defaults to :3000;
# override when the console was moved: CONSOLE_PORT=3100 pnpm dev:tunnel 3100
CONSOLE_PORT="${CONSOLE_PORT:-3000}"
CF_LOG=/tmp/alethia-cf.log
URL_FILE=/tmp/alethia-cf-url.txt

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "✗ cloudflared not installed — run: brew install cloudflared" >&2
  exit 1
fi

echo "→ starting Cloudflare quick tunnel → http://localhost:$PORT …"
pkill -f 'cloudflared tunnel' 2>/dev/null || true
sleep 1
nohup cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate \
  > "$CF_LOG" 2>&1 &
disown

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1 || true)"
  [[ -n "$URL" ]] && break
  sleep 1
done
if [[ -z "$URL" ]]; then
  echo "✗ no tunnel URL after 40s — see $CF_LOG" >&2
  tail -20 "$CF_LOG" >&2 || true
  exit 1
fi
printf '%s\n' "$URL" > "$URL_FILE"
echo "✓ tunnel up: $URL  →  http://localhost:$PORT"

# Re-point the console's auth origin at the tunnel (a running process can't be
# re-pointed, so restart it). Marketing :3010 + proxy :3024 are unaffected.
echo "→ restarting console (:$CONSOLE_PORT) with auth origin $URL …"
lsof -ti tcp:"$CONSOLE_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
rm -rf /tmp/alethia-dev-console.lock
sleep 1
PORT="$CONSOLE_PORT" ALETHIA_PUBLIC_URL="$URL" nohup bash scripts/dev-up.sh \
  > /tmp/alethia-devup.boot.log 2>&1 &
disown

echo ""
echo "  Open in your browser:  $URL"
echo "  (login at $URL/login — no interstitial; sign in with email-OTP)"
echo "  Logs: pnpm dev:logs   ·   Tunnel log: $CF_LOG"
