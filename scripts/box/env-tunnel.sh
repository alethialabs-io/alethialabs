#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs ON the box. Rebuilds the cloudflared ingress from the registry and (re)starts
# the connector, so every live environment's hostname is routed.
#
# One cloudflared for the whole box, LOCALLY managed (config file + credentials file)
# rather than the token form — a token tunnel takes its ingress from the Cloudflare
# dashboard and there is no way to add a hostname to one from here. infra/sandbox
# creates the tunnel with config_src = "local" precisely so this works, and mints the
# credentials from state so nobody ever runs `cloudflared tunnel login`.
#
# The tunnel dials OUT, so the box needs no inbound port and the public hostname
# survives the box being deleted and recreated on a different IP. That stability is
# the whole reason for it: BETTER_AUTH_URL has to match the origin the browser used,
# and an origin that changed on every env:up would break every authed page.
set -euo pipefail

DIR=/opt/alethia/cloudflared
REG=/opt/alethia/envs.json

# shellcheck disable=SC1091
[ -f /opt/alethia/box.env ] && . /opt/alethia/box.env
DOMAIN="${ALETHIA_ENV_DOMAIN:?ALETHIA_ENV_DOMAIN missing from /opt/alethia/box.env}"

if [ ! -s "$DIR/credentials.json" ] || [ ! -s "$DIR/tunnel-id" ]; then
  echo "✗ tunnel not configured — $DIR/{credentials.json,tunnel-id} missing." >&2
  echo "  These are installed by \`pnpm env:up\` from tofu state; run that." >&2
  exit 1
fi

id="$(cat "$DIR/tunnel-id")"

# The primary hostname (the bare domain) is served by whichever env is named after the
# env_subdomain — by convention the `dev` integration env. Branch envs get
# <slug>.<domain>. Both are covered by the single wildcard DNS record.
{
  echo "tunnel: $id"
  echo "credentials-file: $DIR/credentials.json"
  echo "ingress:"
  jq -r --arg d "$DOMAIN" \
    'to_entries[] | "  - hostname: \(.key).\($d)\n    service: http://localhost:\(.value.consolePort)"' \
    "$REG"
  # The integration env answers on the bare domain too, so dev.alethialabs.io works
  # as well as dev.dev.alethialabs.io would have.
  if [ "$(jq -r 'has("dev")' "$REG")" = "true" ]; then
    echo "  - hostname: $DOMAIN"
    echo "    service: http://localhost:$(jq -r '.dev.consolePort' "$REG")"
  fi
  # Required catch-all.
  echo "  - service: http_status:404"
} >"$DIR/config.yml"

# systemd rather than a bare nohup: the connector must come back after a reboot, and
# a dev box gets rebooted by unattended-upgrades.
cat >/etc/systemd/system/alethia-tunnel.service <<UNIT
[Unit]
Description=Alethia sandbox cloudflared connector
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --config $DIR/config.yml run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable alethia-tunnel >/dev/null 2>&1 || true
systemctl restart alethia-tunnel

echo "tunnel: ingress rebuilt for $(jq -r 'keys | join(", ")' "$REG")"
