#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Step 2: apply EXACTLY the saved plan plan.sh wrote (`tofu apply tfplan`) — never a fresh plan. It
# re-summarises the saved plan first and refuses one that deletes, replaces or creates a credential.
# OpenTofu itself refuses a saved plan whose state has moved since it was made.
#
#   apply-saved-plan.sh [--sso-profile alethia-sso] [--dry-run]
#
# Object Lock COMPLIANCE is irreversible: once an object is written, nobody — root included — can
# delete it for 4018 days. Read plan.sh's output before running this.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SSO_PROFILE="alethia-sso"

while [ $# -gt 0 ]; do
	case "$1" in
	--sso-profile) SSO_PROFILE="${2:?}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '5,12p' "$0"; exit 0 ;;
	*) die "unknown argument: $1 (see --help)" ;;
	esac
done

require_cmd tofu jq
resolve_account_id >/dev/null
export AWS_PROFILE="$SSO_PROFILE" TF_IN_AUTOMATION=1

cd "$STACK_DIR"
[ -f "$PLAN_FILE" ] || die "no saved plan at $STACK_DIR/$PLAN_FILE — run ops/plan.sh first and read it"

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tofu show -json "$PLAN_FILE" >"$WORK/plan.json"
summarize_plan_json "$WORK/plan.json" || die "the saved plan is refused (see above); not applying"

if [ "$DRY_RUN" = 1 ]; then
	log "DRY-RUN would run in $STACK_DIR: tofu apply $PLAN_FILE"
	exit 0
fi

log "applying the saved plan summarised above"
tofu apply -input=false "$PLAN_FILE" >&2
rm -f "$PLAN_FILE"

cat <<EOF

Applied. Next:
  · infra/books-archive/ops/mint-console-writer-key.sh --dry-run, then without --dry-run
  · fill alethia/books/connectors (README "Fill the connectors secret")
  · non-secret values: cd infra/books-archive && tofu output console_env ; tofu output books_monthly_role_arn
EOF
