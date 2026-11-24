#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Shared helpers for the infra/books-archive operator scripts. Sourced, never run. Modelled on
# infra/backup-account/ops/lib.sh.
#
# Rules every script here keeps:
#   · no secret is ever printed, logged, put on a command line (where `ps` would show it) or left on
#     disk after the script exits;
#   · --dry-run changes nothing anywhere and makes no AWS call that writes;
#   · re-running after success is a no-op that says so.
#
# Never add `set -x` to anything that sources this: mint-console-writer-key.sh holds an access key in
# memory.

# shellcheck disable=SC2034  # constants are read by the scripts that source this file

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$OPS_DIR/.." && pwd)"

ARCHIVE_REGION="eu-central-1"
PLATFORM_ACCOUNT_ID="270587882865"
ADMIN_ROLE_NAME="alethia-backup-admin"
WRITER_USER_NAME="console-books-writer"
VAULT_ASM_SECRET_ID="alethia/prod/env"
VAULT_REGION="eu-central-1"
VAULT_KEY_ID_VAR="BOOKS_ARCHIVE_ACCESS_KEY_ID"
VAULT_SECRET_VAR="BOOKS_ARCHIVE_SECRET_ACCESS_KEY"
PLAN_FILE="tfplan"

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

# Prints the archive account id committed in terraform.tfvars (backup_account_id). Exits if it is
# not a 12-digit id or equals the platform account.
resolve_account_id() {
	local id=""
	if [ -f "$STACK_DIR/terraform.tfvars" ]; then
		id="$(sed -n 's/^[[:space:]]*backup_account_id[[:space:]]*=[[:space:]]*"\([0-9]\{12\}\)".*/\1/p' "$STACK_DIR/terraform.tfvars" | head -n 1)"
	fi
	[[ "$id" =~ ^[0-9]{12}$ ]] || die "no backup_account_id in $STACK_DIR/terraform.tfvars"
	[ "$id" != "$PLATFORM_ACCOUNT_ID" ] || die "the archive account id equals the platform account ($PLATFORM_ACCOUNT_ID); refusing"
	printf '%s\n' "$id"
}

# Exits unless FILE exists, naming what goes in it (in --dry-run, only warns).
need_file() {
	[ -f "$1" ] && return 0
	if [ "$DRY_RUN" = 1 ]; then
		warn "missing $1 — $2 (a real run stops here)"
		return 0
	fi
	die "missing $1 — $2 (see infra/books-archive/README.md)"
}

# Assumes alethia-backup-admin in ACCOUNT_ID from PROFILE and exports the session into this shell's
# environment, so later `aws` calls run in the archive account. Credentials are read from the CLI's
# JSON into variables and never printed. Verifies the session landed in ACCOUNT_ID.
assume_archive_admin() {
	local profile="$1" account_id="$2" creds key secret token landed
	creds="$(aws sts assume-role --profile "$profile" \
		--role-arn "arn:aws:iam::${account_id}:role/${ADMIN_ROLE_NAME}" \
		--role-session-name "alethia-books-archive-ops" --duration-seconds 3600 \
		--query Credentials --output json)" || die "could not assume ${ADMIN_ROLE_NAME} in ${account_id} from profile ${profile}"
	# printf is a builtin (no argv a `ps` could show) and a pipe never touches disk.
	key="$(printf '%s' "$creds" | jq -r .AccessKeyId)"
	secret="$(printf '%s' "$creds" | jq -r .SecretAccessKey)"
	token="$(printf '%s' "$creds" | jq -r .SessionToken)"
	unset creds
	export AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token"
	export AWS_REGION="$ARCHIVE_REGION" AWS_DEFAULT_REGION="$ARCHIVE_REGION"
	unset AWS_PROFILE key secret token
	landed="$(aws sts get-caller-identity --query Account --output text)"
	[ "$landed" = "$account_id" ] || die "the assumed session is in ${landed}, not ${account_id}; refusing"
	log "acting as ${ADMIN_ROLE_NAME} in ${account_id}"
}

# Reads a `tofu show -json` plan from FILE and prints a human summary to stdout: counts by action,
# every resource address with its action, and the facts the operator must see before applying
# (Object Lock mode and days, the identities' granted actions, any credential resource). Returns 3 if
# the plan would DELETE or REPLACE anything — this stack's resources are meant to live for eleven
# years, so a destroy is never routine — and 4 if it would create a credential or secret value.
summarize_plan_json() {
	local file="$1" rc=0
	jq -r '
		def act: (.change.actions | join("+"));
		[.resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])] as $rc
		| "Plan summary",
		  "  create: \([$rc[] | select(.change.actions == ["create"])] | length)",
		  "  update: \([$rc[] | select(.change.actions == ["update"])] | length)",
		  "  delete: \([$rc[] | select(.change.actions | index("delete"))] | length)  (replacements included)",
		  "",
		  "Resources:",
		  ($rc[] | "  \(act)\t\(.address)")
	' "$file" || return 1

	jq -r '
		[.resource_changes[]? | select(.type == "aws_s3_bucket_object_lock_configuration") | .change.after.rule[0].default_retention[0]?] as $l
		| if ($l | length) > 0 then "\nObject Lock default retention: \($l[0].mode) / \($l[0].days) days" else empty end
	' "$file"

	jq -r '
		.resource_changes[]?
		| select(.type == "aws_iam_role_policy" or .type == "aws_iam_user_policy")
		| select(.change.after.policy != null)
		| "\nGranted by \(.address):",
		  ((.change.after.policy | fromjson | .Statement[] | select(.Effect == "Allow")
		    | "  \([.Action] | flatten | join(", "))  on  \([.Resource] | flatten | join(", "))"))
	' "$file"

	if jq -e '[.resource_changes[]? | select(.change.actions | index("delete"))] | length > 0' "$file" >/dev/null; then
		printf '\nREFUSE: this plan deletes or replaces a resource. Nothing in this stack is meant to be destroyed; read the plan above and resolve it by hand.\n'
		rc=3
	fi
	if jq -e '[.resource_changes[]? | select(.type | test("^aws_iam_(access_key|user_login_profile|service_specific_credential|signing_certificate)$|^aws_secretsmanager_secret_version$"))] | length > 0' "$file" >/dev/null; then
		printf '\nREFUSE: this plan creates a credential or secret value, which would land in the state.\n'
		rc=4
	fi
	return "$rc"
}
