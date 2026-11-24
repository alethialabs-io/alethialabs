#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Step 1: init and PLAN infra/books-archive into a saved plan file (`tofu plan -out=tfplan`), then
# print a human summary of it. Changes nothing in AWS. Read the summary (and the full plan above it)
# before running apply-saved-plan.sh, which applies exactly this file.
#
#   plan.sh [--sso-profile alethia-sso] [--dry-run]
#   plan.sh --self-test        # the summary's refusal logic against fixed plans; no tofu, no AWS
#
#   --sso-profile  the Alethia platform SSO profile: the state backend, and the provider (which
#                  assumes alethia-backup-admin in the backup account). Default alethia-sso
#   --dry-run      print the commands only; run no tofu at all
#
# Inputs it expects (gitignored; README "Inputs"): emails.auto.tfvars, box.auto.tfvars.
#
# Exit: 0 plan saved and clean of refusals (or "No changes"); 3 the plan deletes/replaces something;
# 4 it creates a credential; 5 a check block warned; 1 anything else.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SSO_PROFILE="alethia-sso"
SELF_TEST=0

while [ $# -gt 0 ]; do
	case "$1" in
	--sso-profile) SSO_PROFILE="${2:?}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	--self-test) SELF_TEST=1; shift ;;
	-h | --help) sed -n '5,19p' "$0"; exit 0 ;;
	*) die "unknown argument: $1 (see --help)" ;;
	esac
done

# Feeds summarize_plan_json fixed plans and checks each verdict. A refusal nobody has seen fire is
# indistinguishable from no refusal.
self_test() {
	require_cmd jq
	local dir fails=0 rc
	dir="$(mktemp -d)"
	trap 'rm -rf "$dir"' RETURN
	cat >"$dir/clean.json" <<'EOF'
{"resource_changes":[
 {"address":"aws_s3_bucket.archive","type":"aws_s3_bucket","change":{"actions":["create"],"after":{}}},
 {"address":"aws_s3_bucket_object_lock_configuration.archive","type":"aws_s3_bucket_object_lock_configuration","change":{"actions":["create"],"after":{"rule":[{"default_retention":[{"mode":"COMPLIANCE","days":4018}]}]}}},
 {"address":"aws_iam_user_policy.writer","type":"aws_iam_user_policy","change":{"actions":["create"],"after":{"policy":"{\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::b/inbound/console/*\"}]}"}}},
 {"address":"data.aws_caller_identity.current","type":"aws_caller_identity","change":{"actions":["read"],"after":{}}}
]}
EOF
	cat >"$dir/replace.json" <<'EOF'
{"resource_changes":[
 {"address":"aws_kms_key.archive","type":"aws_kms_key","change":{"actions":["delete","create"],"after":{}}}
]}
EOF
	cat >"$dir/key.json" <<'EOF'
{"resource_changes":[
 {"address":"aws_iam_access_key.writer","type":"aws_iam_access_key","change":{"actions":["create"],"after":{}}}
]}
EOF
	rc=0; summarize_plan_json "$dir/clean.json" >"$dir/out" || rc=$?
	if [ "$rc" = 0 ] && grep -q 'COMPLIANCE / 4018 days' "$dir/out" && grep -q 's3:PutObject  on  arn:aws:s3:::b/inbound/console/\*' "$dir/out"; then
		echo "ok   a clean plan passes and shows the lock and the grants"
	else
		echo "FAIL a clean plan (rc=$rc)"; fails=$((fails + 1))
	fi
	rc=0; summarize_plan_json "$dir/replace.json" >/dev/null || rc=$?
	if [ "$rc" = 3 ]; then echo "ok   a replacement is refused (3)"; else echo "FAIL a replacement gave rc=$rc, want 3"; fails=$((fails + 1)); fi
	rc=0; summarize_plan_json "$dir/key.json" >/dev/null || rc=$?
	if [ "$rc" = 4 ]; then echo "ok   an access-key resource is refused (4)"; else echo "FAIL an access key gave rc=$rc, want 4"; fails=$((fails + 1)); fi
	[ "$fails" = 0 ] || die "plan.sh --self-test: $fails failure(s)"
	echo "plan.sh --self-test: all passed"
}

if [ "$SELF_TEST" = 1 ]; then
	self_test
	exit 0
fi

require_cmd tofu jq
ACCOUNT_ID="$(resolve_account_id)"
export AWS_PROFILE="$SSO_PROFILE" TF_IN_AUTOMATION=1

need_file "$STACK_DIR/emails.auto.tfvars" "budget_alert_emails = [\"...\"]"
need_file "$STACK_DIR/box.auto.tfvars" "console_writer_source_cidrs = [\"<box ipv4>/32\", \"<box ipv6>/128\"]"

if [ "$DRY_RUN" = 1 ]; then
	log "DRY-RUN would run in $STACK_DIR: tofu init -backend-config=backend.hcl; tofu plan -out=$PLAN_FILE; tofu show -json $PLAN_FILE (summarised)"
	exit 0
fi

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$STACK_DIR"
[ -f backend.hcl ] || cp backend.hcl.example backend.hcl
rm -f "$PLAN_FILE"
log "init (state: alethia-tofu-state-${PLATFORM_ACCOUNT_ID} · books-archive/)"
tofu init -input=false -backend-config=backend.hcl >&2

log "plan for account ${ACCOUNT_ID} → $STACK_DIR/$PLAN_FILE"
plan_rc=0
tofu plan -input=false -detailed-exitcode -out="$PLAN_FILE" 2>&1 | tee "$WORK/plan.log" >&2 || plan_rc=${PIPESTATUS[0]}
case "$plan_rc" in
0)
	rm -f "$PLAN_FILE"
	log "No changes. Nothing to apply."
	exit 0
	;;
2) ;;
*) rm -f "$PLAN_FILE"; die "tofu plan failed (exit $plan_rc)" ;;
esac

# A check block only WARNS, and the plan still exits 2. Treat a warning as a stop here.
warned=0
grep -q 'Check block assertion failed' "$WORK/plan.log" && warned=1

summary_rc=0
tofu show -json "$PLAN_FILE" >"$WORK/tfplan.json"
summarize_plan_json "$WORK/tfplan.json" || summary_rc=$?

if [ "$summary_rc" != 0 ]; then
	rm -f "$PLAN_FILE"
	exit "$summary_rc"
fi
if [ "$warned" = 1 ]; then
	rm -f "$PLAN_FILE"
	warn "a check block failed (see the plan output above). The saved plan was removed; fix the cause and re-plan."
	exit 5
fi

cat <<EOF

Saved plan: $STACK_DIR/$PLAN_FILE
Read the full plan above. Before applying, confirm:
  · the bucket alethia-books-archive-${ACCOUNT_ID} with object_lock_enabled = true
  · Object Lock COMPLIANCE / 4018 days — IRREVERSIBLE for every object written afterwards
  · console-books-writer grants only s3:PutObject on inbound/console/* (+ KMS through S3)
  · books-monthly trusts only repo:alethialabs-io/books:environment:books
Then: infra/books-archive/ops/apply-saved-plan.sh
EOF
