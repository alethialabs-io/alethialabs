#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Step 4: READ-ONLY posture check of the live backup account. Changes nothing; safe to run any time.
#
#   04-verify.sh [--sso-profile alethia-sso] [--account-id ID] [--dry-run]
#
# Checks, each printed PASS or FAIL (exit 1 if any FAIL):
#   · the bucket: Object Lock enabled, COMPLIANCE, 15 days; versioning on; SSE-KMS with a Bucket
#     Key; all four public-access blocks; a policy that denies aws:SecureTransport=false
#   · backup-writer: only its one inline policy, no managed policy or group, no Delete action in
#     it, and IAM's own simulator denies it s3:DeleteObject / s3:DeleteObjectVersion /
#     s3:PutObjectRetention on the bucket
#   · the KMS key behind alias/alethia-prod-backup: Enabled, rotation on
#   · the drill identity secret exists (its value is never read)
#
#   --dry-run  list the checks without calling AWS
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SSO_PROFILE="alethia-sso"
ACCOUNT_ARG=""

while [ $# -gt 0 ]; do
	case "$1" in
	--sso-profile) SSO_PROFILE="${2:?}"; shift 2 ;;
	--account-id) ACCOUNT_ARG="${2:?}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '5,19p' "$0"; exit 0 ;;
	*) die "unknown argument: $1 (see --help)" ;;
	esac
done

if [ "$DRY_RUN" = 1 ]; then
	sed -n '9,17p' "$0"
	exit 0
fi

require_cmd aws jq
ACCOUNT_ID="$(resolve_account_id "$ACCOUNT_ARG")"
BUCKET="alethia-prod-backup-${ACCOUNT_ID}"
assume_backup_admin "$SSO_PROFILE" "$ACCOUNT_ID"

FAILS=0
# Records one check: check "<what>" <command…>; the command's success is the verdict.
check() {
	local what="$1"
	shift
	if "$@" >/dev/null 2>&1; then
		printf 'PASS  %s\n' "$what"
	else
		printf 'FAIL  %s\n' "$what"
		FAILS=$((FAILS + 1))
	fi
}

# Succeeds when the JSON on stdin satisfies the jq FILTER.
jq_true() { jq -e "$1" >/dev/null; }

lock="$(aws s3api get-object-lock-configuration --bucket "$BUCKET" --output json 2>/dev/null || echo '{}')"
check "bucket ${BUCKET}: Object Lock enabled" jq_true '.ObjectLockConfiguration.ObjectLockEnabled == "Enabled"' <<<"$lock"
check "bucket: default retention COMPLIANCE" jq_true '.ObjectLockConfiguration.Rule.DefaultRetention.Mode == "COMPLIANCE"' <<<"$lock"
check "bucket: default retention 15 days" jq_true '.ObjectLockConfiguration.Rule.DefaultRetention.Days == 15' <<<"$lock"

ver="$(aws s3api get-bucket-versioning --bucket "$BUCKET" --output json 2>/dev/null || echo '{}')"
check "bucket: versioning Enabled" jq_true '.Status == "Enabled"' <<<"$ver"

enc="$(aws s3api get-bucket-encryption --bucket "$BUCKET" --output json 2>/dev/null || echo '{}')"
check "bucket: SSE-KMS with a Bucket Key" jq_true \
	'.ServerSideEncryptionConfiguration.Rules[0] | .ApplyServerSideEncryptionByDefault.SSEAlgorithm == "aws:kms" and .BucketKeyEnabled == true' <<<"$enc"

pab="$(aws s3api get-public-access-block --bucket "$BUCKET" --output json 2>/dev/null || echo '{}')"
check "bucket: all four public-access blocks on" jq_true \
	'.PublicAccessBlockConfiguration | .BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets' <<<"$pab"

pol="$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text 2>/dev/null || echo '{}')"
check "bucket: policy denies plain HTTP" jq_true \
	'[.Statement[] | select(.Effect == "Deny" and .Condition.Bool["aws:SecureTransport"] == "false")] | length >= 1' <<<"$pol"

writer_arn="$(aws iam get-user --user-name "$WRITER_USER_NAME" --query User.Arn --output text 2>/dev/null || echo "")"
check "writer ${WRITER_USER_NAME} exists" test -n "$writer_arn"
inline="$(aws iam list-user-policies --user-name "$WRITER_USER_NAME" --query 'PolicyNames' --output json 2>/dev/null || echo 'null')"
check "writer: exactly one inline policy (${WRITER_POLICY_NAME})" jq_true ". == [\"${WRITER_POLICY_NAME}\"]" <<<"$inline"
managed="$(aws iam list-attached-user-policies --user-name "$WRITER_USER_NAME" --query 'AttachedPolicies' --output json 2>/dev/null || echo 'null')"
check "writer: no managed policy attached" jq_true '. == []' <<<"$managed"
groups="$(aws iam list-groups-for-user --user-name "$WRITER_USER_NAME" --query 'Groups' --output json 2>/dev/null || echo 'null')"
check "writer: in no group" jq_true '. == []' <<<"$groups"
doc="$(aws iam get-user-policy --user-name "$WRITER_USER_NAME" --policy-name "$WRITER_POLICY_NAME" --query PolicyDocument --output json 2>/dev/null || echo '{}')"
check "writer: no Delete or wildcard action granted" jq_true \
	'[.Statement[] | select(.Effect == "Allow") | .Action | if type == "array" then .[] else . end | select(test("delete|\\*"; "i"))] | length == 0 and (.Statement | length) > 0' <<<"$doc"

if [ -n "$writer_arn" ]; then
	sim="$(aws iam simulate-principal-policy --policy-source-arn "$writer_arn" \
		--action-names s3:DeleteObject s3:DeleteObjectVersion s3:PutObjectRetention \
		--resource-arns "arn:aws:s3:::${BUCKET}/alethia-prod/latest.json" \
		--query 'EvaluationResults[].EvalDecision' --output json 2>/dev/null || echo '["error"]')"
	check "writer: IAM simulator denies delete and retention changes" jq_true 'all(. != "allowed") and (length == 3)' <<<"$sim"
fi

key="$(aws kms describe-key --key-id "$KMS_ALIAS" --output json 2>/dev/null || echo '{}')"
check "KMS ${KMS_ALIAS}: present and Enabled" jq_true '.KeyMetadata.KeyState == "Enabled"' <<<"$key"
key_id="$(jq -r '.KeyMetadata.KeyId // ""' <<<"$key")"
rot="$(aws kms get-key-rotation-status --key-id "${key_id:-none}" --output json 2>/dev/null || echo '{}')"
check "KMS: automatic rotation on" jq_true '.KeyRotationEnabled == true' <<<"$rot"

check "drill identity secret ${DRILL_SECRET_NAME} exists" aws secretsmanager describe-secret --secret-id "$DRILL_SECRET_NAME"

echo
if [ "$FAILS" -gt 0 ]; then
	echo "${FAILS} check(s) FAILED"
	exit 1
fi
echo "all checks passed"
