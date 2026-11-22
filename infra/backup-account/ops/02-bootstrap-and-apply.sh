#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Step 2: init and PLAN the bootstrap (the alethia-backup-admin role), then the main stack. Prints
# each plan. Applies ONLY with --apply, and then applies exactly the saved plan it just printed.
# Idempotent: a stack with nothing to change plans "No changes" and is not applied.
#
#   02-bootstrap-and-apply.sh --management-profile P [--sso-profile alethia-sso] \
#       [--account-id ID] [--stage bootstrap|main|all] [--apply] [--dry-run]
#
#   --management-profile  management-account profile, used by the BOOTSTRAP's provider only
#   --sso-profile         the Alethia platform SSO profile: both state backends, and the main
#                         stack's provider (which assumes alethia-backup-admin). Default alethia-sso
#   --account-id          default: backup_account_id in ../terraform.tfvars
#   --stage               which stack(s); default all (bootstrap first)
#   --apply               apply the saved plan(s). Without it, nothing is changed.
#   --dry-run             print the commands only; run no tofu at all
#
# Inputs it expects to exist (all gitignored; README "Inputs"):
#   bootstrap/terraform.tfvars   from bootstrap/terraform.tfvars.example
#   emails.auto.tfvars           budget_alert_emails
#   box.auto.tfvars              writer_source_cidrs
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MGMT_PROFILE=""
SSO_PROFILE="alethia-sso"
ACCOUNT_ARG=""
STAGE="all"
APPLY=0

while [ $# -gt 0 ]; do
	case "$1" in
	--management-profile) MGMT_PROFILE="${2:?}"; shift 2 ;;
	--sso-profile) SSO_PROFILE="${2:?}"; shift 2 ;;
	--account-id) ACCOUNT_ARG="${2:?}"; shift 2 ;;
	--stage) STAGE="${2:?}"; shift 2 ;;
	--apply) APPLY=1; shift ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '5,24p' "$0"; exit 0 ;;
	*) die "unknown argument: $1 (see --help)" ;;
	esac
done

require_cmd tofu aws
case "$STAGE" in bootstrap | main | all) ;; *) die "--stage must be bootstrap, main or all" ;; esac
ACCOUNT_ID="$(resolve_account_id "$ACCOUNT_ARG")"
export TF_VAR_backup_account_id="$ACCOUNT_ID" TF_IN_AUTOMATION=1
# Both backends authenticate with the platform SSO session.
export AWS_PROFILE="$SSO_PROFILE"

# Copies backend.hcl.example to backend.hcl in DIR if it is missing.
ensure_backend() {
	local dir="$1"
	if [ ! -f "$dir/backend.hcl" ]; then
		run cp "$dir/backend.hcl.example" "$dir/backend.hcl"
	fi
}

# Exits unless FILE exists, naming what goes in it (in --dry-run, only warns).
need_file() {
	[ -f "$1" ] && return 0
	if [ "$DRY_RUN" = 1 ]; then
		warn "missing $1 — $2 (a real run stops here)"
		return 0
	fi
	die "missing $1 — $2 (see infra/backup-account/ops/README.md)"
}

# Inits and plans the stack in DIR into PLAN; applies it when --apply was given and the plan has
# changes. Echoes "changes" or "clean" on stdout.
plan_and_maybe_apply() {
	local dir="$1" plan="$2" rc=0
	ensure_backend "$dir"
	if [ "$DRY_RUN" = 1 ]; then
		printf 'DRY-RUN would run in %s: tofu init -backend-config=backend.hcl; tofu plan -out=%s' "$dir" "$plan" >&2
		[ "$APPLY" = 1 ] && printf '; tofu apply %s' "$plan" >&2
		printf '\n' >&2
		echo "changes"
		return 0
	fi
	(cd "$dir" && tofu init -input=false -backend-config=backend.hcl >&2)
	(cd "$dir" && tofu plan -input=false -detailed-exitcode -out="$plan" >&2) || rc=$?
	case "$rc" in
	0)
		log "$(basename "$dir"): no changes"
		echo "clean"
		return 0
		;;
	2) ;;
	*) die "tofu plan failed in $dir" ;;
	esac
	if [ "$APPLY" = 1 ]; then
		log "$(basename "$dir"): applying the plan printed above"
		(cd "$dir" && tofu apply -input=false "$plan" >&2)
		echo "clean"
	else
		log "$(basename "$dir"): plan has changes; re-run with --apply to apply it"
		echo "changes"
	fi
}

if [ "$STAGE" != main ]; then
	[ -n "$MGMT_PROFILE" ] || die "--management-profile is required for the bootstrap stage"
	need_file "$STACK_DIR/bootstrap/terraform.tfvars" "copy bootstrap/terraform.tfvars.example and fill admin_principal_arns"
	export TF_VAR_management_profile="$MGMT_PROFILE"
	log "bootstrap (alethia-backup-admin) in ${ACCOUNT_ID}"
	boot="$(plan_and_maybe_apply "$STACK_DIR/bootstrap" bootstrap.tfplan)"
	unset TF_VAR_management_profile
	if [ "$boot" = changes ] && [ "$STAGE" = all ] && [ "$DRY_RUN" = 0 ]; then
		log "stopping before the main stack: it applies THROUGH the role the bootstrap creates, so it cannot plan until the bootstrap is applied"
		exit 0
	fi
fi

if [ "$STAGE" != bootstrap ]; then
	need_file "$STACK_DIR/emails.auto.tfvars" "budget_alert_emails = [\"...\"]"
	need_file "$STACK_DIR/box.auto.tfvars" "writer_source_cidrs = [\"<box ipv4>/32\", \"<box ipv6>/128\"]"
	log "main stack in ${ACCOUNT_ID}"
	plan_and_maybe_apply "$STACK_DIR" main.tfplan >/dev/null
fi

log "done. Next: 04-verify.sh (read-only), then 03-mint-writer-key.sh"
