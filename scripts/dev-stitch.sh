#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OU <legal@alethialabs.io>
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
# The console stays on :3100 so the `management` clone keeps :3000. The committed
# microfrontends.json says console=:3000, so we feed the proxy a generated temp
# config with console.development.local=$CONSOLE_PORT (never editing the real file).
#
# Prereq (one-time, interactive): cloudflared tunnel login  (+ a created `alethia-dev`
# tunnel routed to the hostname -- `pnpm dev:tunnel:named` does that the first time).
#
# Knobs: HOSTNAME (arg1, default dev.alethialabs.io), CONSOLE_PORT (3100),
#        MARKETING_PORT (3010, hardcoded in marketing's dev script), PROXY_PORT (3024),
#        TUNNEL_NAME (alethia-dev). Teardown: pnpm dev:stitch:down
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
MKT_LOCK=/tmp/alethia-dev-marketing.lock
MKT_LOG=/tmp/alethia-dev-marketing.log
PROXY_LOG=/tmp/alethia-mfe-proxy.log
PROXY_PIDF=/tmp/alethia-mfe-proxy.pid
CF_LOG=/tmp/alethia-cf-named.log
MFE_BIN="apps/console/node_modules/.bin/microfrontends"
URL="https://$HOSTNAME_ARG"

[[ -f .env ]] || { echo "x no .env -- run: cp .env.example .env" >&2; exit 1; }
command -v cloudflared >/dev/null 2>&1 || { echo "x cloudflared not installed (brew install cloudflared)" >&2; exit 1; }
[[ -f "$CFDIR/cert.pem" ]] || { echo "x not logged in -- run once: cloudflared tunnel login, then: pnpm dev:tunnel:named" >&2; exit 1; }
[[ -x "$MFE_BIN" ]] || { echo "x $MFE_BIN missing -- run: pnpm install" >&2; exit 1; }

# ---- 1) Console + backends on :CONSOLE_PORT with the tunnel host as auth origin ----
# dev-up.sh is lock-guarded (singleton). FORCE so we always (re)point the origin.
echo "-> console + backends on :$CONSOLE_PORT (origin $URL) ..."
PORT="$CONSOLE_PORT" ALETHIA_PUBLIC_URL="$URL" FORCE=1 nohup bash scripts/dev-up.sh \
  > /tmp/alethia-devup.boot.log 2>&1 &
disown

# ---- 2) Marketing on :MARKETING_PORT (sourced root .env + tunnel-host public vars) ----
if [[ -d "$MKT_LOCK" ]] && kill -0 "$(cat "$MKT_LOCK/pid" 2>/dev/null || echo)" 2>/dev/null; then
  echo "-> marketing already running (pid $(cat "$MKT_LOCK/pid"))"
else
  rm -rf "$MKT_LOCK"; mkdir "$MKT_LOCK"
  echo "-> starting marketing on :$MARKETING_PORT ..."
  # Subshell: source root .env, override public origin to the tunnel host, run detached.
  ( set -a; # shellcheck disable=SC1091
    source ./.env; set +a
    export NEXT_PUBLIC_APP_URL="$URL" NEXT_PUBLIC_SITE_URL="$URL" NEXT_PUBLIC_LEGAL_URL="$URL"
    nohup pnpm -C apps/marketing dev > "$MKT_LOG" 2>&1 &
    echo $! > "$MKT_LOCK/pid" )
  echo "   (logs: tail -f $MKT_LOG)"
fi

# ---- 3) Microfrontends proxy on :PROXY_PORT with console pointed at :CONSOLE_PORT ----
# Generate a temp config so we don't touch the committed microfrontends.json.
node -e '
  const fs=require("fs");
  const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  c.applications.console.development.local=Number(process.argv[2]);
  c.applications.marketing.development.local=Number(process.argv[3]);
  fs.writeFileSync(process.argv[4], JSON.stringify(c,null,2));
' "$MFE_SRC" "$CONSOLE_PORT" "$MARKETING_PORT" "$MFE_GEN"
echo "-> wrote $MFE_GEN (console=$CONSOLE_PORT, marketing=$MARKETING_PORT)"

pkill -f 'microfrontends proxy' 2>/dev/null || true
[[ -f "$PROXY_PIDF" ]] && kill "$(cat "$PROXY_PIDF")" 2>/dev/null || true
sleep 1
echo "-> starting microfrontends proxy on :$PROXY_PORT ..."
nohup "$MFE_BIN" proxy "$MFE_GEN" --local-apps console marketing --port "$PROXY_PORT" \
  > "$PROXY_LOG" 2>&1 &
echo $! > "$PROXY_PIDF"
disown

echo "-> waiting for proxy :$PROXY_PORT ..."
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null --max-time 2 "http://localhost:$PROXY_PORT" 2>/dev/null && break
  sleep 1
done

# ---- 4) Named tunnel -> the proxy ----
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1; exit}')"
if [[ -z "$UUID" ]]; then
  echo "x tunnel '$TUNNEL_NAME' not found -- run once: pnpm dev:tunnel:named (creates + routes DNS)" >&2
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
pkill -f 'cloudflared tunnel' 2>/dev/null || true
sleep 2
nohup cloudflared tunnel --config "$CONFIG" run "$TUNNEL_NAME" > "$CF_LOG" 2>&1 &
disown

echo ""
echo "ok stitched site up:  $URL"
echo "   cloudflared -> proxy :$PROXY_PORT -> console :$CONSOLE_PORT + marketing :$MARKETING_PORT"
echo "   logged-out /  -> marketing landing   ;   logged-in / -> console org"
echo "   logs: pnpm dev:logs (console) . tail -f $MKT_LOG (marketing) . $PROXY_LOG . $CF_LOG"
echo "   stop: pnpm dev:stitch:down   .   runners: pnpm dev:runner"
