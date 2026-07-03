#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OU <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Expose the dev console over a *named* Cloudflare tunnel at a STABLE hostname
# (default dev.alethialabs.io) and re-point the console's auth origin at it so
# sign-in is same-origin. Unlike `pnpm dev:tunnel` (random quick-tunnel URL per
# run), this hostname is permanent -- so social OAuth works once you register
# https://<hostname>/api/auth/callback/* redirect URIs in your providers.
#
#   pnpm dev:tunnel:named                 # dev.alethialabs.io -> console :3000
#   pnpm dev:tunnel:named dev2.example.io # a different hostname
#
# One-time prerequisite (interactive, do it yourself):
#   cloudflared tunnel login              # authorize the zone in your CF account
#
# Idempotent: reuses the tunnel/DNS/config if they already exist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOSTNAME_ARG="${1:-${TUNNEL_HOSTNAME:-dev.alethialabs.io}}"
TUNNEL_NAME="${TUNNEL_NAME:-alethia-dev}"
# Port the console runs on (the one to kill + restart). Override: CONSOLE_PORT=3100 ...
CONSOLE_PORT="${CONSOLE_PORT:-3000}"
CFDIR="$HOME/.cloudflared"
CONFIG="$CFDIR/config.yml"
CF_LOG=/tmp/alethia-cf-named.log

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "x cloudflared not installed -- run: brew install cloudflared" >&2
  exit 1
fi
if [[ ! -f "$CFDIR/cert.pem" ]]; then
  echo "x not logged in -- run once:  cloudflared tunnel login   (authorize the ${HOSTNAME_ARG#*.} zone)" >&2
  exit 1
fi

# Create the named tunnel if it doesn't exist yet (writes ~/.cloudflared/<UUID>.json).
if ! cloudflared tunnel list 2>/dev/null | awk -v n="${TUNNEL_NAME}" '$2==n{f=1} END{exit !f}'; then
  echo "-> creating tunnel ${TUNNEL_NAME} ..."
  cloudflared tunnel create "${TUNNEL_NAME}"
else
  echo "-> reusing existing tunnel ${TUNNEL_NAME}"
fi

# Resolve the tunnel UUID (first column of the list row) and its credentials file.
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="${TUNNEL_NAME}" '$2==n{print $1; exit}')"
if [[ -z "${UUID}" ]]; then
  echo "x could not resolve UUID for tunnel ${TUNNEL_NAME}." >&2
  exit 1
fi
CREDS="$CFDIR/${UUID}.json"
if [[ ! -f "${CREDS}" ]]; then
  echo "x credentials file ${CREDS} missing (re-run: cloudflared tunnel create ${TUNNEL_NAME})." >&2
  exit 1
fi

# Point the hostname's DNS at the tunnel (idempotent -- errors if the record exists).
echo "-> routing DNS ${HOSTNAME_ARG} to ${TUNNEL_NAME} ..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME_ARG}" 2>&1 | sed 's/^/  /' || true

# Write the ingress config: the stable hostname -> the local console.
cat > "${CONFIG}" <<EOF
tunnel: ${UUID}
credentials-file: ${CREDS}
ingress:
  - hostname: ${HOSTNAME_ARG}
    service: http://localhost:${CONSOLE_PORT}
  - service: http_status:404
EOF
echo "-> wrote ${CONFIG}"

# Run the tunnel detached. Kill ANY existing cloudflared first: a stale process
# bound to an old config/port keeps its own connection to the same tunnel, so
# Cloudflare round-robins onto the dead origin (intermittent 502). The match must
# be broad -- the real command is "cloudflared tunnel --config ... run", which a
# narrow 'cloudflared tunnel run' pattern would miss.
pkill -f 'cloudflared tunnel' 2>/dev/null || true
sleep 2
nohup cloudflared tunnel --config "${CONFIG}" run "${TUNNEL_NAME}" > "${CF_LOG}" 2>&1 &
disown
echo "ok tunnel running: https://${HOSTNAME_ARG} -> http://localhost:${CONSOLE_PORT}  (log: ${CF_LOG})"

# Re-point the console's auth origin at the stable hostname (a running process can't
# be re-pointed, so restart it via dev-up.sh with ALETHIA_PUBLIC_URL set).
echo "-> restarting console (:${CONSOLE_PORT}) with auth origin https://${HOSTNAME_ARG} ..."
lsof -ti tcp:"${CONSOLE_PORT}" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
rm -rf /tmp/alethia-dev-console.lock
sleep 1
PORT="${CONSOLE_PORT}" ALETHIA_PUBLIC_URL="https://${HOSTNAME_ARG}" nohup bash scripts/dev-up.sh \
  > /tmp/alethia-devup.boot.log 2>&1 &
disown

echo ""
echo "  Open in your browser:  https://${HOSTNAME_ARG}"
echo "  (sign in with email-OTP; or add https://${HOSTNAME_ARG}/api/auth/callback/* to your OAuth apps)"
echo "  Console logs: pnpm dev:logs   .   Tunnel log: ${CF_LOG}"
echo "  Start runners against it:  pnpm dev:runner"
