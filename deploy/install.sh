#!/bin/sh
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Alethia self-host installer — one command on a fresh Linux VM:
#
#   curl -fsSL https://get.alethialabs.io/self-host | sh
#
# With a domain (gets automatic HTTPS):
#   curl -fsSL https://get.alethialabs.io/self-host | DOMAIN=alethia.example.com ACME_EMAIL=you@example.com sh
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
	log "Updating ${ALETHIA_DIR}…"
	$SUDO git -C "$ALETHIA_DIR" fetch --depth 1 origin "$REF"
	$SUDO git -C "$ALETHIA_DIR" checkout -f "origin/$REF" 2>/dev/null || $SUDO git -C "$ALETHIA_DIR" checkout -f "$REF"
else
	log "Cloning into ${ALETHIA_DIR}…"
	$SUDO mkdir -p "$ALETHIA_DIR"
	$SUDO git clone --depth 1 --branch "$REF" "$REPO_URL" "$ALETHIA_DIR"
fi
cd "$ALETHIA_DIR"

# 3. .env with generated secrets
#
# deploy/selfhost/secrets.manifest is the one list of instance secrets, and
# deploy/selfhost/secrets.sh reads it. A first install generates every `required` entry; a
# re-run fills any `required` entry the existing .env does not have yet (a secret added in a
# later release) and never rewrites a value that is set.
# shellcheck source=SCRIPTDIR/selfhost/secrets.sh
. deploy/selfhost/secrets.sh

# explain_placeholder KEY — how to replace KEY's value on an install that already has data.
explain_placeholder() {
	case "$1" in
		ALETHIA_CRED_ENCRYPTION_KEY | ALETHIA_OIDC_SIGNING_KEY | ALETHIA_DB_PASSWORD | ALETHIA_APP_DB_PASSWORD | OPENFGA_DB_PASSWORD | ALETHIA_STORAGE_ACCESS_KEY_ID | ALETHIA_STORAGE_SECRET_ACCESS_KEY)
			printf '  %s: data or a running service depends on this value, so do not edit it in place.\n    Run: sh %s/deploy/selfhost/rotate-secret.sh %s\n' "$1" "$ALETHIA_DIR" "$1" ;;
		*)
			printf '  %s: run: sh %s/deploy/selfhost/rotate-secret.sh %s\n    Sessions and tokens signed with the old value stop being accepted.\n' "$1" "$ALETHIA_DIR" "$1" ;;
	esac
}

# warn_placeholders — when $stale names keys, print them with how to replace each one.
# A warning only: the run continues and those values are left as they are. The console
# refuses to start in production while one remains.
stale=""
warn_placeholders() {
	[ -n "$stale" ] || return 0
	{
		printf '\033[33m! %s/.env holds a template placeholder for: %s\033[0m\n' "$ALETHIA_DIR" "$stale"
		printf '  Those values were not changed. Replace each one:\n'
		for _key in $stale; do
			explain_placeholder "$_key"
		done
	} >&2
}

if [ ! -f .env ]; then
	log "Creating .env with generated secrets…"
	(umask 077 && $SUDO cp .env.example .env)
	if [ -n "$DOMAIN" ]; then
		env_set NEXT_PUBLIC_APP_URL "https://$DOMAIN" .env
		env_set BETTER_AUTH_URL "https://$DOMAIN" .env
	fi
	# Domain + ACME email drive Caddy (not in .env.example by default).
	env_set ALETHIA_DOMAIN "$DOMAIN" .env
	env_set ALETHIA_ACME_EMAIL "$ACME_EMAIL" .env
else
	log ".env already present — keeping every value it has."
	# A re-run with a different DOMAIN silently keeps the old one — warn so it isn't mistaken
	# for a domain change (edit .env by hand, or remove it to regenerate).
	if [ -n "$DOMAIN" ] && ! grep -qE "^ALETHIA_DOMAIN=$DOMAIN$" .env 2>/dev/null; then
		printf '\033[33m! DOMAIN=%s differs from the existing .env — not changed. Edit %s/.env to update it.\033[0m\n' "$DOMAIN" "$ALETHIA_DIR" >&2
	fi
fi
filled="$(fill_required_secrets .env)" || die "install.sh: could not generate the instance secrets (is openssl working?). .env was left as it was before the failing key."
[ -z "$filled" ] || log "Generated: $filled"
# Every required secret must now hold a generated value.
for key in $(manifest_secrets required); do
	value="$(env_get "$key" .env)"
	[ -n "$value" ] || die "install.sh: $key has no value in $ALETHIA_DIR/.env — refusing to start."
done
stale="$(placeholder_secrets .env)"
warn_placeholders

# 4. Bring up the bundle from prebuilt public GHCR images (no on-box build)
compose() {
	$SUDO docker compose -f docker-compose.yml -f deploy/prod/docker-compose.prod.yml "$@"
}
log "Starting the stack…"
compose pull
compose up -d --remove-orphans
# The object store's identity is rendered from the storage keys in .env by docker-compose.yml
# (configs: seaweedfs-identity). When this run generated them, recreate the store so it reads them.
case " $filled " in
	*" ALETHIA_STORAGE_ACCESS_KEY_ID "* | *" ALETHIA_STORAGE_SECRET_ACCESS_KEY "*)
		log "Storage keys generated — recreating the object store…"
		compose up -d --force-recreate seaweedfs ;;
esac

if [ -n "$DOMAIN" ]; then
	URL="https://$DOMAIN"
else
	URL="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
log "Alethia is starting at ${URL}"
# The backticks below are literal help text, not a command substitution — SC2016 is a false positive.
# shellcheck disable=SC2016
printf '  Next: edit %s/.env for OAuth + email (ALETHIA_SES_*), then re-run this script (or `docker compose ... up -d`).\n' "$ALETHIA_DIR"
# Repeated here so it is the last thing on screen, below the compose output.
warn_placeholders
