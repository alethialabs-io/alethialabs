#!/bin/sh
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Rotate one instance secret on a self-hosted box. POSIX sh: it needs only a shell, openssl and
# docker compose — no Node toolchain on the box. Run it from anywhere, as the user that runs the
# stack (it uses sudo for docker and .env when not root, like deploy/install.sh):
#
#   sh /opt/alethia/deploy/selfhost/rotate-secret.sh ALETHIA_CRON_SECRET
#   sh /opt/alethia/deploy/selfhost/rotate-secret.sh --list
#
# It generates the new value with the secret's generator from deploy/selfhost/secrets.manifest,
# writes it to .env, and does whatever else that secret needs so the stack keeps working:
#
#   ALETHIA_CRED_ENCRYPTION_KEY     keyring rotation with no downtime: the current key stays in the
#                                   ring as ALETHIA_CRED_ENCRYPTION_KEY_<old kid>, the new key gets
#                                   the next kid, then every stored ciphertext is re-sealed under
#                                   it (db:reencrypt, run inside the migrate image).
#   ALETHIA_OIDC_SIGNING_KEY        the current key moves to ALETHIA_OIDC_SIGNING_KEY_PREVIOUS, so
#                                   the issuer keeps publishing it while tokens it signed expire.
#   ALETHIA_DB_PASSWORD             ALTER ROLE in the bundled Postgres first, then .env.
#   ALETHIA_APP_DB_PASSWORD         .env, then the migrate one-shot sets the role's password.
#   OPENFGA_DB_PASSWORD             ALTER ROLE in the OpenFGA Postgres first, then .env.
#   ALETHIA_STORAGE_ACCESS_KEY_ID / ALETHIA_STORAGE_SECRET_ACCESS_KEY
#                                   .env, then the object store is recreated: docker-compose.yml
#                                   renders its identity from these two.
#   anything else                   .env, then the services that read it are recreated.
#
# Then the stack is brought up again with the new value. Nothing here prints a secret value.
#
# Env: ALETHIA_COMPOSE_FILES — the compose files the stack runs with (default: the files
#      deploy/install.sh uses).
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

log() { printf '\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
export SUDO

command -v openssl >/dev/null 2>&1 || die "openssl is required"
# shellcheck source=SCRIPTDIR/secrets.sh
. deploy/selfhost/secrets.sh

COMPOSE_FILES="${ALETHIA_COMPOSE_FILES:--f docker-compose.yml -f deploy/prod/docker-compose.prod.yml}"
# compose ARGS… — docker compose with the stack's files. COMPOSE_FILES is split on purpose.
compose() {
	# shellcheck disable=SC2086
	$SUDO docker compose $COMPOSE_FILES "$@"
}

usage() {
	printf 'Usage: sh %s <NAME> | --list\n' "$0" >&2
	exit 64
}

[ $# -eq 1 ] || usage
NAME="$1"
if [ "$NAME" = "--list" ]; then
	manifest_secrets all
	exit 0
fi
[ -n "$(manifest_field "$NAME" 3)" ] || die "$NAME is not in $SECRETS_MANIFEST (see --list)."
[ -f .env ] || die "no .env in $ROOT — run deploy/install.sh first."

# psql_as_superuser SERVICE ROLE DB — run the SQL on stdin in SERVICE's Postgres. The SQL travels
# on stdin, so the new password is never on a command line.
psql_as_superuser() {
	compose exec -T "$1" psql -v ON_ERROR_STOP=1 -X -q -U "$2" -d "$3" >/dev/null
}

# sql_literal VALUE — VALUE as a single-quoted SQL literal. Generated values are hex or base64,
# so this only has to double any single quote.
sql_literal() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

new="$(generate_secret "$NAME")" || die "could not generate a new value for $NAME."
old="$(env_get "$NAME" .env)"

case "$NAME" in
	ALETHIA_CRED_ENCRYPTION_KEY)
		[ -n "$old" ] || die "$NAME is empty — there is nothing to rotate; run deploy/install.sh to generate it."
		old_kid="$(env_get ALETHIA_CRED_ENCRYPTION_KID .env)"
		old_kid="${old_kid:-1}"
		case "$old_kid" in
			*[!0-9]* | "") new_kid="$(date -u +%Y%m%d%H%M%S)" ;;
			*) new_kid=$((old_kid + 1)) ;;
		esac
		log "Keeping the current key in the ring as ALETHIA_CRED_ENCRYPTION_KEY_${old_kid}; new key id ${new_kid}."
		env_set "ALETHIA_CRED_ENCRYPTION_KEY_${old_kid}" "$old" .env
		env_set ALETHIA_CRED_ENCRYPTION_KEY "$new" .env
		env_set ALETHIA_CRED_ENCRYPTION_KID "$new_kid" .env
		log "Restarting the console with the new keyring…"
		compose up -d app
		log "Re-sealing every stored ciphertext under key id ${new_kid}…"
		override="$(mktemp)"
		# The migrate image carries the full console toolchain; give that one run the keyring from
		# .env. The override holds a file reference only, no value.
		printf 'services:\n  migrate:\n    env_file: [.env]\n' >"$override"
		# shellcheck disable=SC2086
		if ! $SUDO docker compose $COMPOSE_FILES -f "$override" run --rm --no-deps migrate node_modules/.bin/tsx scripts/reencrypt-secrets.ts; then
			rm -f "$override"
			die "re-encryption did not finish. Every key is still in the ring, so the console keeps working. The pass is idempotent and resumable: fix the cause and run it again with
  printf 'services:\\n  migrate:\\n    env_file: [.env]\\n' > /tmp/reencrypt.yml
  docker compose $COMPOSE_FILES -f /tmp/reencrypt.yml run --rm --no-deps migrate node_modules/.bin/tsx scripts/reencrypt-secrets.ts"
		fi
		rm -f "$override"
		log "Done. ALETHIA_CRED_ENCRYPTION_KEY_${old_kid} stays in .env; remove it once you have confirmed the console decrypts every connector and alert channel."
		;;
	ALETHIA_OIDC_SIGNING_KEY)
		if [ -n "$old" ]; then
			env_set ALETHIA_OIDC_SIGNING_KEY_PREVIOUS "$old" .env
			log "The current key is kept as ALETHIA_OIDC_SIGNING_KEY_PREVIOUS while tokens it signed expire."
		fi
		env_set "$NAME" "$new" .env
		compose up -d app
		;;
	ALETHIA_DB_PASSWORD)
		user="$(env_get ALETHIA_DB_USER .env)"
		db="$(env_get ALETHIA_DB_NAME .env)"
		user="${user:-alethia}"
		db="${db:-alethia}"
		log "Changing the password of role ${user} in the bundled Postgres…"
		printf 'ALTER ROLE "%s" PASSWORD %s;\n' "$user" "$(sql_literal "$new")" | psql_as_superuser postgres "$user" "$db"
		env_set "$NAME" "$new" .env
		compose up -d
		;;
	ALETHIA_APP_DB_PASSWORD)
		env_set "$NAME" "$new" .env
		log "Setting the application role's new password (migrate one-shot)…"
		compose run --rm migrate
		compose up -d
		;;
	OPENFGA_DB_PASSWORD)
		if [ -n "$(compose ps -q openfga-db 2>/dev/null)" ]; then
			log "Changing the password of role openfga in the OpenFGA Postgres…"
			printf 'ALTER ROLE openfga PASSWORD %s;\n' "$(sql_literal "$new")" | psql_as_superuser openfga-db openfga openfga
		fi
		env_set "$NAME" "$new" .env
		compose up -d
		;;
	ALETHIA_STORAGE_ACCESS_KEY_ID | ALETHIA_STORAGE_SECRET_ACCESS_KEY)
		env_set "$NAME" "$new" .env
		log "Recreating the object store with its new identity…"
		compose up -d --force-recreate seaweedfs
		compose up -d
		;;
	*)
		env_set "$NAME" "$new" .env
		compose up -d
		;;
esac

log "Rotated $NAME."
