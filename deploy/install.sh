#!/bin/sh
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

# Every value this script generates on a first install. This one list drives the check
# that runs before the stack starts, on a first install and on every re-run.
GENERATED_KEYS="CLI_JWT_SECRET BETTER_AUTH_SECRET ALETHIA_DB_PASSWORD ALETHIA_APP_DB_PASSWORD ALETHIA_CRED_ENCRYPTION_KEY OPENFGA_DB_PASSWORD ALETHIA_STORAGE_ACCESS_KEY_ID ALETHIA_STORAGE_SECRET_ACCESS_KEY ALETHIA_SNAPSHOT_HMAC_KEY ALETHIA_CRON_SECRET"

# SHA-256 of each placeholder value .env.example and docker-compose.yml have shipped for
# the keys above. A placeholder is recognised by digest, so it is still recognised after
# the template stops carrying it. Add to this list; never remove from it.
PLACEHOLDER_DIGESTS="660599fcee9088125a9c926aeff66776919d35087651ad2badbce191dac83692 7e9886e3832c2875145a9fb5fc5148afa5c501e07209ca2222175df80390105c 88de4c7de8ca1ef22b59faaf1e939954caa1a74ce2570fd9296edab041c3e7dc b35dd74e6920a52dc01f24d238c9344e066f64c6a2197edae3ac89228fec3295 bcd6860363c05e59bc10b5b81ddf32a4806d8a664953016e82db22bb6b2b8160 f8d0d021b95e78c7bb4e5be8b05b0c9cfdbb8c9d02a014528795c0461a4ca3f2"

STORAGE_IDENTITY_FILE="deploy/seaweedfs/s3.json"

# get_kv KEY FILE — the value KEY has in FILE (last assignment wins, one pair of
# surrounding quotes dropped). Prints nothing when KEY is absent or empty.
get_kv() {
	$SUDO sed -n "s/^$1=//p" "$2" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# is_placeholder KEY VALUE — true when VALUE is one the template ships for KEY, or one
# it has shipped before.
is_placeholder() {
	[ -n "$2" ] || return 1
	[ "$2" != "$(get_kv "$1" .env.example)" ] || return 0
	_digest="$(printf '%s' "$2" | openssl dgst -sha256 -r | cut -d' ' -f1)"
	case " $PLACEHOLDER_DIGESTS " in
		*" $_digest "*) return 0 ;;
	esac
	return 1
}

# placeholder_keys — the GENERATED_KEYS whose value in .env is a placeholder, or is unset
# while docker-compose.yml would substitute its own default for it.
placeholder_keys() {
	for _key in $GENERATED_KEYS; do
		_value="$(get_kv "$_key" .env)"
		if is_placeholder "$_key" "$_value"; then
			printf '%s ' "$_key"
		elif [ -z "$_value" ] && grep -qF "\${$_key:-" docker-compose.yml; then
			printf '%s ' "$_key"
		fi
	done
}

# explain_placeholder KEY — how to replace KEY's value on an install that already has data.
explain_placeholder() {
	case "$1" in
		ALETHIA_CRED_ENCRYPTION_KEY)
			printf '  %s: stored connector and alert-channel secrets are sealed under this key, so do not\n    swap it in place. Follow the rotation flow written next to ALETHIA_CRED_ENCRYPTION_KID in\n    %s/.env.example (keep the current value as a retired key, set a new key and key id,\n    re-encrypt), then re-run this script.\n' "$1" "$ALETHIA_DIR" ;;
		ALETHIA_DB_PASSWORD | ALETHIA_APP_DB_PASSWORD | OPENFGA_DB_PASSWORD)
			printf '  %s: the database role already uses this value. Change the password of that role in\n    Postgres, then set the same new value in .env.\n' "$1" ;;
		ALETHIA_STORAGE_ACCESS_KEY_ID | ALETHIA_STORAGE_SECRET_ACCESS_KEY)
			printf '  %s: set a new value in .env (openssl rand -hex 32). This script writes it to\n    %s on its next run.\n' "$1" "$STORAGE_IDENTITY_FILE" ;;
		*)
			printf '  %s: set a new value in .env (openssl rand -hex 32). Sessions and tokens signed\n    with the old value stop being accepted.\n' "$1" ;;
	esac
}

# json_escape VALUE — VALUE with backslashes and double quotes escaped for a JSON string.
json_escape() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# render_storage_identity — write the bundled object store's identity file from the
# storage keys in .env. Runs on every invocation: the file is tracked, so the checkout in
# step 2 puts the shipped copy back each time.
render_storage_identity() {
	_id="$(get_kv ALETHIA_STORAGE_ACCESS_KEY_ID .env)"
	_secret="$(get_kv ALETHIA_STORAGE_SECRET_ACCESS_KEY .env)"
	if [ -z "$_id" ] || [ -z "$_secret" ]; then
		log "Storage keys are not set in .env — leaving $STORAGE_IDENTITY_FILE as shipped."
		return 0
	fi
	printf '{\n  "identities": [\n    {\n      "name": "alethia",\n      "credentials": [\n        {\n          "accessKey": "%s",\n          "secretKey": "%s"\n        }\n      ],\n      "actions": ["Admin", "Read", "Write", "List", "Tagging"]\n    }\n  ]\n}\n' \
		"$(json_escape "$_id")" "$(json_escape "$_secret")" | $SUDO tee "$STORAGE_IDENTITY_FILE" >/dev/null
}

# warn_placeholders — when $stale names keys, print them with how to replace each one.
# A warning only: the run continues and .env is left as it is.
stale=""
warn_placeholders() {
	[ -n "$stale" ] || return 0
	{
		printf '\033[33m! %s/.env holds a placeholder value for: %s\033[0m\n' "$ALETHIA_DIR" "$stale"
		printf '  .env was not changed. Replace each one:\n'
		for _key in $stale; do
			explain_placeholder "$_key"
		done
	} >&2
}

if [ ! -f .env ]; then
	log "Creating .env with generated secrets…"
	$SUDO cp .env.example .env
	# Generated values are hex or base64, so they hold nothing the `|` delimiter or the sed
	# replacement treats specially. Fail loud if the key isn't already in .env (copied from
	# .env.example): a plain sed would silently no-op and the box would boot with the
	# default/empty secret.
	set_kv() {
		grep -qE "^$1=" .env || die "install.sh: $1 is missing from .env.example — refusing to leave a default secret"
		$SUDO sed -i "s|^$1=.*|$1=$2|" .env
	}
	set_kv CLI_JWT_SECRET "$(openssl rand -hex 32)"
	set_kv BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
	set_kv ALETHIA_DB_PASSWORD "$(openssl rand -hex 24)"
	set_kv ALETHIA_APP_DB_PASSWORD "$(openssl rand -hex 24)"
	# base64 of 32 bytes — the format the console requires for this key.
	set_kv ALETHIA_CRED_ENCRYPTION_KEY "$(openssl rand -base64 32)"
	set_kv OPENFGA_DB_PASSWORD "$(openssl rand -hex 24)"
	set_kv ALETHIA_STORAGE_ACCESS_KEY_ID "$(openssl rand -hex 16)"
	set_kv ALETHIA_STORAGE_SECRET_ACCESS_KEY "$(openssl rand -hex 32)"
	set_kv ALETHIA_SNAPSHOT_HMAC_KEY "$(openssl rand -hex 32)"
	set_kv ALETHIA_CRON_SECRET "$(openssl rand -hex 32)"
	if [ -n "$DOMAIN" ]; then
		set_kv NEXT_PUBLIC_APP_URL "https://$DOMAIN"
		set_kv BETTER_AUTH_URL "https://$DOMAIN"
	fi
	# Domain + ACME email drive Caddy (appended; not in .env.example by default).
	{
		echo "ALETHIA_DOMAIN=$DOMAIN"
		echo "ALETHIA_ACME_EMAIL=$ACME_EMAIL"
	} | $SUDO tee -a .env >/dev/null
	# Every generated key must now hold a generated value. A failed `openssl rand` leaves
	# an empty one, and `set -e` does not see a failure inside a command substitution.
	for key in $GENERATED_KEYS; do
		value="$(get_kv "$key" .env)"
		[ -n "$value" ] || die "install.sh: $key was not generated — refusing to start. Remove $ALETHIA_DIR/.env and re-run."
		! is_placeholder "$key" "$value" || die "install.sh: $key was not generated — refusing to start. Remove $ALETHIA_DIR/.env and re-run."
	done
else
	log ".env already present — leaving it untouched."
	# A re-run with a different DOMAIN silently keeps the old one — warn so it isn't mistaken
	# for a domain change (edit .env by hand, or remove it to regenerate).
	if [ -n "$DOMAIN" ] && ! grep -qE "^ALETHIA_DOMAIN=$DOMAIN$" .env 2>/dev/null; then
		printf '\033[33m! DOMAIN=%s differs from the existing .env — not changed. Edit %s/.env to update it.\033[0m\n' "$DOMAIN" "$ALETHIA_DIR" >&2
	fi
	# An existing .env is never rewritten here. If it still holds a placeholder for a value
	# a first install generates, say which and how to replace each, then carry on.
	stale="$(placeholder_keys)"
	warn_placeholders
fi

render_storage_identity

# 4. Bring up the bundle from prebuilt public GHCR images (no on-box build)
compose() {
	$SUDO docker compose -f docker-compose.yml -f deploy/prod/docker-compose.prod.yml "$@"
}
log "Starting the stack…"
compose pull
compose up -d --remove-orphans
# A running object store keeps the identity file it started with. When that differs from
# the one just written (the storage keys in .env changed), restart it to pick the new one up.
live_identity="$(compose exec -T seaweedfs cat /etc/seaweedfs/s3.json 2>/dev/null || true)"
if [ -n "$live_identity" ] && [ "$live_identity" != "$($SUDO cat "$STORAGE_IDENTITY_FILE")" ]; then
	log "Storage keys changed — restarting the object store…"
	compose restart seaweedfs
fi

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
