#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Shared helpers for the infra/backup-account operator scripts. Sourced, never run.
#
# Rules every script here keeps:
#   · no secret is ever printed, logged, put on a command line (where `ps` would show it) or left on
#     disk after the script exits;
#   · --dry-run changes nothing anywhere and makes no AWS call that writes;
#   · re-running after success is a no-op that says so.
#
# Never add `set -x` to anything that sources this: 03 holds an access key in memory.

# shellcheck disable=SC2034  # constants are read by the scripts that source this file

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$OPS_DIR/.." && pwd)"

BACKUP_ACCOUNT_NAME="alethia-backup"
BACKUP_REGION="eu-central-1"
PLATFORM_ACCOUNT_ID="270587882865"
ADMIN_ROLE_NAME="alethia-backup-admin"
WRITER_USER_NAME="backup-writer"
WRITER_POLICY_NAME="alethia-backup-write"
KMS_ALIAS="alias/alethia-prod-backup"
DRILL_SECRET_NAME="alethia/backup/drill-age-identity"
VAULT_ASM_SECRET_ID="alethia/prod/env"
VAULT_REGION="eu-central-1"

DRY_RUN=0

# Prints a progress line to stderr.
log() { printf '==> %s\n' "$*" >&2; }

# Prints a warning line to stderr.
warn() { printf 'WARN %s\n' "$*" >&2; }

# Prints an error to stderr and exits 1.
die() {
	printf 'ERROR %s\n' "$*" >&2
	exit 1
}

# Exits unless every named command is on PATH.
require_cmd() {
	local c
	for c in "$@"; do
		command -v "$c" >/dev/null 2>&1 || die "'$c' is required and not on PATH"
	done
}

# Runs the command, or in --dry-run only prints it. Use for every call that WRITES; never pass a
# secret as an argument to it.
run() {
	if [ "$DRY_RUN" = 1 ]; then
		printf 'DRY-RUN would run: %s\n' "$*" >&2
		return 0
	fi
	"$@"
}

# Prints the backup account id: the --account-id value if given, else the one committed in
# terraform.tfvars. Exits if neither is a 12-digit id.
resolve_account_id() {
	local given="${1:-}" id=""
	if [ -n "$given" ]; then
		id="$given"
	elif [ -f "$STACK_DIR/terraform.tfvars" ]; then
		id="$(sed -n 's/^[[:space:]]*backup_account_id[[:space:]]*=[[:space:]]*"\([0-9]\{12\}\)".*/\1/p' "$STACK_DIR/terraform.tfvars" | head -n 1)"
	fi
	[[ "$id" =~ ^[0-9]{12}$ ]] || die "no backup account id: pass --account-id, or commit backup_account_id in $STACK_DIR/terraform.tfvars (README step 1)"
	[ "$id" != "$PLATFORM_ACCOUNT_ID" ] || die "the backup account id equals the platform account ($PLATFORM_ACCOUNT_ID); refusing"
	printf '%s\n' "$id"
}

# Assumes alethia-backup-admin in ACCOUNT_ID from PROFILE and exports the session into this shell's
# environment, so later `aws` calls run in the backup account. Credentials are read from the CLI's
# JSON into variables and never printed. Verifies the session landed in ACCOUNT_ID.
assume_backup_admin() {
	local profile="$1" account_id="$2" creds key secret token landed
	creds="$(aws sts assume-role --profile "$profile" \
		--role-arn "arn:aws:iam::${account_id}:role/${ADMIN_ROLE_NAME}" \
		--role-session-name "alethia-backup-ops" --duration-seconds 3600 \
		--query Credentials --output json)" || die "could not assume ${ADMIN_ROLE_NAME} in ${account_id} from profile ${profile} (has the bootstrap been applied?)"
	# printf is a builtin (no argv a `ps` could show) and a pipe never touches disk, unlike a
	# here-string, which older bash writes to a temp file.
	key="$(printf '%s' "$creds" | jq -r .AccessKeyId)"
	secret="$(printf '%s' "$creds" | jq -r .SecretAccessKey)"
	token="$(printf '%s' "$creds" | jq -r .SessionToken)"
	unset creds
	export AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token"
	export AWS_REGION="$BACKUP_REGION" AWS_DEFAULT_REGION="$BACKUP_REGION"
	unset AWS_PROFILE key secret token
	landed="$(aws sts get-caller-identity --query Account --output text)"
	[ "$landed" = "$account_id" ] || die "the assumed session is in ${landed}, not ${account_id}; refusing"
	log "acting as ${ADMIN_ROLE_NAME} in ${account_id}"
}
