#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Serve the PRODUCTION-accurate stitched site (console + marketing behind the
# microfrontends proxy) over the stable named tunnel, so dev.alethialabs.io behaves
# like hosted: logged-out / -> marketing landing, logged-in / -> console org.
# One command: `pnpm dev:stitch`.
#
# Topology (native, no Docker/Caddy):
#   cloudflared (dev.alethialabs.io) -> mfe proxy :3024 -> console :3100 + marketing :3010
#
# SELF-HEALING: each long-lived service runs under a respawn supervisor, so a crash
# (these native `next dev` servers die under memory/swap pressure every so often)
# self-restarts within ~2s instead of taking the whole site down. Supervisor pids are
# recorded in /tmp/alethia-sup-*.pid; `pnpm dev:stitch:down` stops them.
#
# Console stays on :3100 so a separate project can keep :3000. The committed
# microfrontends.json says console=:3000, so we feed the proxy a generated temp config
# with console.development.local=$CONSOLE_PORT (never editing the real file).
#
# Prereq (one-time, interactive): cloudflared tunnel login  (+ `pnpm dev:tunnel:named`
# once to create the `alethia-dev` tunnel + DNS route).
#
# Knobs: HOSTNAME (arg1, default dev.alethialabs.io), CONSOLE_PORT (3100),
#        MARKETING_PORT (3010, hardcoded in marketing's dev script), PROXY_PORT (3024),
#        TUNNEL_NAME (alethia-dev).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOSTNAME_ARG="${1:-${TUNNEL_HOSTNAME:-dev.alethialabs.io}}"
CONSOLE_PORT="${CONSOLE_PORT:-3100}"
MARKETING_PORT="${MARKETING_PORT:-3010}"
PROXY_PORT="${PROXY_PORT:-3024}"
TUNNEL_NAME="${TUNNEL_NAME:-alethia-dev}"

CFDIR="$HOME/.cloudflared"
CONFIG="$CFDIR/config.yml"
MFE_SRC="apps/console/microfrontends.json"
MFE_GEN=/tmp/alethia-mfe-config.json
MFE_BIN="apps/console/node_modules/.bin/microfrontends"
CONSOLE_LOG=/tmp/alethia-devup.boot.log
MKT_LOG=/tmp/alethia-dev-marketing.log
PROXY_LOG=/tmp/alethia-mfe-proxy.log
CF_LOG=/tmp/alethia-cf-named.log
URL="https://$HOSTNAME_ARG"

[[ -f .env ]] || { echo "x no .env -- run: cp .env.example .env" >&2; exit 1; }
command -v cloudflared >/dev/null 2>&1 || { echo "x cloudflared not installed (brew install cloudflared)" >&2; exit 1; }
[[ -f "$CFDIR/cert.pem" ]] || { echo "x not logged in -- run once: cloudflared tunnel login, then: pnpm dev:tunnel:named" >&2; exit 1; }
[[ -x "$MFE_BIN" ]] || { echo "x $MFE_BIN missing -- run: pnpm install" >&2; exit 1; }

# Launch a self-restarting supervisor for one service. Records the SUPERVISOR pid.
#   supervise <name> <logfile> <cmd...>
supervise() {
  local name="$1" log="$2"; shift 2
  ( while true; do
      "$@" || true
      echo "[supervise] $name exited (rc=$?) -- restarting in 2s" >&2
      sleep 2
    done ) >> "$log" 2>&1 &
  echo $! > "/tmp/alethia-sup-$name.pid"
  echo "-> supervising $name (sup pid $!, log: $log)"
}

# Clean slate: stop any prior supervisors + children (idempotent re-run).
bash scripts/dev-stitch-down.sh >/dev/null 2>&1 || true

# Generate the proxy config with console pointed at :CONSOLE_PORT (don't touch the committed file).
node -e '
  const fs=require("fs");
  const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  c.applications.console.development.local=Number(process.argv[2]);
  c.applications.marketing.development.local=Number(process.argv[3]);
  fs.writeFileSync(process.argv[4], JSON.stringify(c,null,2));
' "$MFE_SRC" "$CONSOLE_PORT" "$MARKETING_PORT" "$MFE_GEN"
echo "-> wrote $MFE_GEN (console=$CONSOLE_PORT, marketing=$MARKETING_PORT)"

# Resolve the tunnel (must already exist from `pnpm dev:tunnel:named`) + write ingress -> proxy.
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1; exit}')"
if [[ -z "$UUID" ]]; then
  echo "x tunnel '$TUNNEL_NAME' not found -- run once: pnpm dev:tunnel:named" >&2
  exit 1
fi
cat > "$CONFIG" <<EOF
tunnel: $UUID
credentials-file: $CFDIR/$UUID.json
ingress:
  - hostname: $HOSTNAME_ARG
    service: http://localhost:$PROXY_PORT
  - service: http_status:404
EOF
echo "-> wrote $CONFIG (ingress -> :$PROXY_PORT)"

# ---- Start the four supervised services ----
# console + backends on :CONSOLE_PORT with the tunnel host as auth origin (dev-up.sh is
# idempotent; FORCE reclaims a stale lock left by a hard-killed prior console).
supervise console "$CONSOLE_LOG" \
  env PORT="$CONSOLE_PORT" ALETHIA_PUBLIC_URL="$URL" FORCE=1 bash scripts/dev-up.sh

# marketing on :MARKETING_PORT -- source root .env, then override public origin to the tunnel host.
supervise marketing "$MKT_LOG" \
  bash -c "set -a; source ./.env; set +a; export NEXT_PUBLIC_APP_URL='$URL' NEXT_PUBLIC_SITE_URL='$URL' NEXT_PUBLIC_LEGAL_URL='$URL'; exec pnpm -C apps/marketing dev"

# microfrontends proxy on :PROXY_PORT.
supervise proxy "$PROXY_LOG" \
  "$MFE_BIN" proxy "$MFE_GEN" --local-apps console marketing --port "$PROXY_PORT"

# cloudflared named tunnel -> proxy.
supervise cloudflared "$CF_LOG" \
  cloudflared tunnel --config "$CONFIG" run "$TUNNEL_NAME"

echo "-> waiting for proxy :$PROXY_PORT ..."
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null --max-time 2 "http://localhost:$PROXY_PORT" 2>/dev/null && break
  sleep 1
done

echo ""
echo "ok stitched site up (self-healing):  $URL"
echo "   cloudflared -> proxy :$PROXY_PORT -> console :$CONSOLE_PORT + marketing :$MARKETING_PORT"
echo "   each service auto-restarts on crash (~2s). logs: pnpm dev:logs (console) . tail -f $MKT_LOG . $PROXY_LOG . $CF_LOG"
echo "   stop: pnpm dev:stitch:down   .   runners: pnpm dev:runner"
