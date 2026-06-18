#!/bin/sh
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Alethia self-host installer — one command on a fresh Linux VM:
#
#   curl -fsSL https://raw.githubusercontent.com/alethialabs-io/alethialabs/main/deploy/install.sh | sh
#
# With a domain (gets automatic HTTPS):
#   curl -fsSL .../deploy/install.sh | DOMAIN=alethia.example.com ACME_EMAIL=you@example.com sh
#
# Env overrides: DOMAIN, ACME_EMAIL, ALETHIA_DIR (=/opt/alethia), REF (=main),
#                REPO_URL. Idempotent — re-run to upgrade.
#
# (This installs the whole platform. The CLI-only installer is a different script,
#  apps/console/public/install.sh served at get.alethialabs.io.)
set -eu

REPO_URL="${REPO_URL:-https://github.com/alethialabs-io/alethialabs.git}"
ALETHIA_DIR="${ALETHIA_DIR:-/opt/alethia}"
REF="${REF:-main}"
DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"

log()  { printf '\033[1m▸ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

command -v git >/dev/null 2>&1 || die "git is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

# 1. Docker + compose plugin
if ! command -v docker >/dev/null 2>&1; then
	log "Installing Docker…"
	curl -fsSL https://get.docker.com | $SUDO sh
	$SUDO systemctl enable --now docker 2>/dev/null || true
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found (install Docker Compose v2)"

# 2. Fetch / update the repo (compose files live here)
if [ -d "$ALETHIA_DIR/.git" ]; then
	log "Updating $ALETHIA_DIR…"
	$SUDO git -C "$ALETHIA_DIR" fetch --depth 1 origin "$REF"
	$SUDO git -C "$ALETHIA_DIR" checkout -f "origin/$REF" 2>/dev/null || $SUDO git -C "$ALETHIA_DIR" checkout -f "$REF"
else
	log "Cloning into $ALETHIA_DIR…"
	$SUDO mkdir -p "$ALETHIA_DIR"
	$SUDO git clone --depth 1 --branch "$REF" "$REPO_URL" "$ALETHIA_DIR"
fi
cd "$ALETHIA_DIR"

# 3. .env with generated secrets (only on first install)
if [ ! -f .env ]; then
	log "Creating .env with generated secrets…"
	$SUDO cp .env.example .env
	# hex values are sed-safe (no / or + to clash with the delimiter)
	set_kv() { $SUDO sed -i "s|^$1=.*|$1=$2|" .env; }
	set_kv CLI_JWT_SECRET "$(openssl rand -hex 32)"
	set_kv BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
	set_kv ALETHIA_DB_PASSWORD "$(openssl rand -hex 24)"
	set_kv ALETHIA_APP_DB_PASSWORD "$(openssl rand -hex 24)"
	if [ -n "$DOMAIN" ]; then
		set_kv NEXT_PUBLIC_APP_URL "https://$DOMAIN"
		set_kv BETTER_AUTH_URL "https://$DOMAIN"
	fi
	# Domain + ACME email drive Caddy (appended; not in .env.example by default).
	{
		echo "ALETHIA_DOMAIN=$DOMAIN"
		echo "ALETHIA_ACME_EMAIL=$ACME_EMAIL"
	} | $SUDO tee -a .env >/dev/null
else
	log ".env already present — leaving it untouched."
fi

# 4. Bring up the bundle from prebuilt public GHCR images (no on-box build)
log "Starting the stack…"
$SUDO docker compose -f docker-compose.yml -f deploy/prod/docker-compose.prod.yml pull
$SUDO docker compose -f docker-compose.yml -f deploy/prod/docker-compose.prod.yml up -d --remove-orphans

if [ -n "$DOMAIN" ]; then
	URL="https://$DOMAIN"
else
	URL="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
log "Alethia is starting at ${URL}"
printf '  Next: edit %s/.env for OAuth + RESEND_API_KEY, then re-run this script (or `docker compose ... up -d`).\n' "$ALETHIA_DIR"
