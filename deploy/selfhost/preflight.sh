#!/bin/sh
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Self-host preflight — checks every instance secret in deploy/selfhost/secrets.manifest before
# the stack starts, and exits non-zero, naming each variable, when one is not usable.
#
# The self-host overlay runs it as the one-shot `preflight` service, ahead of `migrate`, so a box
# with an unusable secret never migrates or starts the console. An operator can run the same check
# on the host before an upgrade:
#
#   sh deploy/selfhost/preflight.sh --env-file .env
#
# Without --env-file it reads the process environment (the service gets .env through env_file).
#
# What it checks:
#   - every `required` entry is set and not empty;
#   - no entry, required or optional, holds a template placeholder or a published sample value
#     (deploy/selfhost/secrets.sh recognises both: an angle-bracketed `<…>` marker, or a value
#     whose SHA-256 is one a template has carried).
#
# It prints variable names and how to fix each one, never a value. POSIX sh with only awk, sed,
# grep and sha256sum (or openssl), so it runs in the console-migrate image without a toolchain.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SECRETS_MANIFEST="${SECRETS_MANIFEST:-$HERE/secrets.manifest}"
# shellcheck source=SCRIPTDIR/secrets.sh
. "$HERE/secrets.sh"

ENV_FILE=""
while [ $# -gt 0 ]; do
	case "$1" in
		--env-file)
			[ $# -ge 2 ] || { echo "preflight: --env-file needs a path" >&2; exit 2; }
			ENV_FILE="$2"
			shift 2 ;;
		--env-file=*)
			ENV_FILE="${1#--env-file=}"
			shift ;;
		-h | --help)
			sed -n '5,14p' "$0" | sed 's/^# \{0,1\}//'
			exit 0 ;;
		*)
			echo "preflight: unknown argument $1 (usage: preflight.sh [--env-file FILE])" >&2
			exit 2 ;;
	esac
done
if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
	echo "preflight: $ENV_FILE does not exist" >&2
	exit 2
fi

[ -f "$SECRETS_MANIFEST" ] || { echo "preflight: $SECRETS_MANIFEST is missing" >&2; exit 2; }
required="$(manifest_secrets required)"
[ -n "$required" ] || { echo "preflight: $SECRETS_MANIFEST lists no required secret — has it changed shape?" >&2; exit 2; }

# secret_value NAME — NAME's value, from --env-file when given, else from the environment.
secret_value() {
	if [ -n "$ENV_FILE" ]; then
		env_get "$1" "$ENV_FILE"
		return
	fi
	# NAME comes from the manifest; only a plain variable name is ever expanded.
	case "$1" in
		"" | [!A-Z]* | *[!A-Z0-9_]*) return 0 ;;
	esac
	eval "printf '%s' \"\${$1-}\""
}

# fix_hint NAME — how to give NAME a usable value.
fix_hint() {
	case "$(manifest_field "$1" 4)" in
		required)
			printf '    Fix: re-run deploy/install.sh, which generates every missing instance secret,\n'
			printf '    or replace a set value with: sh deploy/selfhost/rotate-secret.sh %s\n' "$1" ;;
		*)
			printf '    Fix: remove the line to leave the feature off, or generate a value with:\n'
			printf '    sh deploy/selfhost/rotate-secret.sh %s\n' "$1" ;;
	esac
}

problems=0
report() {
	problems=$((problems + 1))
	printf '  %s %s\n' "$1" "$2" >&2
	fix_hint "$1" >&2
}

{
	printf 'preflight: checking the instance secrets in %s' "$(basename "$SECRETS_MANIFEST")"
	[ -z "$ENV_FILE" ] || printf ' against %s' "$ENV_FILE"
	printf '\n'
}

for name in $(manifest_secrets all); do
	value="$(secret_value "$name")"
	if [ -z "$value" ]; then
		[ "$(manifest_field "$name" 4)" = "required" ] || continue
		report "$name" "is not set. Every required instance secret is generated per install."
	elif is_placeholder "$value"; then
		report "$name" "holds a template placeholder, not a generated value."
	fi
done

if [ "$problems" -gt 0 ]; then
	printf 'preflight: %s instance secret(s) above are not usable, so the stack will not start.\n' "$problems" >&2
	printf '  The manifest and how each secret is made: deploy/selfhost/README.md\n' >&2
	exit 1
fi
printf 'preflight: every required instance secret is set, and none holds a template placeholder.\n'
