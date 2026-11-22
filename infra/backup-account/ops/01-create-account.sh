#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Step 1: create the `alethia-backup` member account and give its Identity Center admins access.
# Run with the ORGANIZATION'S MANAGEMENT-ACCOUNT credentials. Idempotent: an existing ACTIVE account
# of that name, and an existing assignment, are reused and reported.
#
#   01-create-account.sh --management-profile P --root-email E \
#       --sso-principal-id ID [--sso-principal-type USER|GROUP] \
#       [--permission-set AdministratorAccess] [--dry-run]
#
#   --management-profile  local AWS CLI profile for the management account (never committed)
#   --root-email          the new account's root email (a fresh address; never committed). Needed
#                         only when the account does not exist yet.
#   --sso-principal-id    the Identity Center user or group id to grant the permission set
#                         (aws identitystore list-users --identity-store-id <id>)
#   --permission-set      default AdministratorAccess — must equal sso_admin_permission_set in
#                         ../terraform.tfvars, which the bucket policy names as the admins
#   --dry-run             look everything up, print what would be created, create nothing
#
# Prints the account id and the one line to commit in ../terraform.tfvars.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MGMT_PROFILE=""
ROOT_EMAIL=""
PRINCIPAL_ID=""
PRINCIPAL_TYPE="USER"
PERMISSION_SET="AdministratorAccess"

while [ $# -gt 0 ]; do
	case "$1" in
	--management-profile) MGMT_PROFILE="${2:?}"; shift 2 ;;
	--root-email) ROOT_EMAIL="${2:?}"; shift 2 ;;
	--sso-principal-id) PRINCIPAL_ID="${2:?}"; shift 2 ;;
	--sso-principal-type) PRINCIPAL_TYPE="${2:?}"; shift 2 ;;
	--permission-set) PERMISSION_SET="${2:?}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '5,24p' "$0"; exit 0 ;;
	*) die "unknown argument: $1 (see --help)" ;;
	esac
done

require_cmd aws jq
[ -n "$MGMT_PROFILE" ] || die "--management-profile is required"
[ -n "$PRINCIPAL_ID" ] || die "--sso-principal-id is required"
case "$PRINCIPAL_TYPE" in USER | GROUP) ;; *) die "--sso-principal-type must be USER or GROUP" ;; esac
export AWS_PROFILE="$MGMT_PROFILE"

# 1. These are management-account credentials, of the organization the account will join.
caller="$(aws sts get-caller-identity --query Account --output text)"
master="$(aws organizations describe-organization --query Organization.MasterAccountId --output text)" ||
	die "describe-organization failed: is ${MGMT_PROFILE} a management-account profile?"
[ "$caller" = "$master" ] || die "profile ${MGMT_PROFILE} is account ${caller}, not the organization's management account"
log "management account confirmed"

# 2. The account: reuse, or create.
account_id="$(aws organizations list-accounts \
	--query "Accounts[?Name=='${BACKUP_ACCOUNT_NAME}' && Status=='ACTIVE'] | [0].Id" --output text)"
if [[ "$account_id" =~ ^[0-9]{12}$ ]]; then
	log "account ${BACKUP_ACCOUNT_NAME} already exists: ${account_id} (reused)"
else
	account_id=""
	[ -n "$ROOT_EMAIL" ] || die "account ${BACKUP_ACCOUNT_NAME} does not exist; --root-email is required to create it"
	if [ "$DRY_RUN" = 1 ]; then
		log "DRY-RUN would create member account ${BACKUP_ACCOUNT_NAME} (billing access for IAM users: DENY)"
	else
		log "creating member account ${BACKUP_ACCOUNT_NAME}"
		req="$(aws organizations create-account --email "$ROOT_EMAIL" --account-name "$BACKUP_ACCOUNT_NAME" \
			--iam-user-access-to-billing DENY --query CreateAccountStatus.Id --output text)"
		for _ in $(seq 1 60); do
			state="$(aws organizations describe-create-account-status --create-account-request-id "$req" \
				--query 'CreateAccountStatus.[State,AccountId,FailureReason]' --output text)"
			case "$state" in
			SUCCEEDED*) account_id="$(awk '{print $2}' <<<"$state")"; break ;;
			FAILED*) die "account creation failed: ${state#FAILED}" ;;
			esac
			sleep 10
		done
		[[ "$account_id" =~ ^[0-9]{12}$ ]] || die "account creation did not finish in 10 minutes (request ${req}); re-run to pick it up"
		log "created ${BACKUP_ACCOUNT_NAME}: ${account_id}"
	fi
fi

# 3. Identity Center: the permission set on the account for the principal.
read -r instance_arn store_id <<<"$(aws sso-admin list-instances --query 'Instances[0].[InstanceArn,IdentityStoreId]' --output text)"
[ -n "$instance_arn" ] && [ "$instance_arn" != "None" ] || die "no IAM Identity Center instance in this organization"

ps_arn=""
for arn in $(aws sso-admin list-permission-sets --instance-arn "$instance_arn" --query 'PermissionSets[]' --output text); do
	name="$(aws sso-admin describe-permission-set --instance-arn "$instance_arn" --permission-set-arn "$arn" --query PermissionSet.Name --output text)"
	if [ "$name" = "$PERMISSION_SET" ]; then
		ps_arn="$arn"
		break
	fi
done
[ -n "$ps_arn" ] || die "no permission set named ${PERMISSION_SET} in Identity Center (store ${store_id})"

if [ -z "$account_id" ]; then
	log "DRY-RUN would assign ${PERMISSION_SET} to ${PRINCIPAL_TYPE} ${PRINCIPAL_ID} on the new account"
else
	have="$(aws sso-admin list-account-assignments --instance-arn "$instance_arn" --account-id "$account_id" \
		--permission-set-arn "$ps_arn" \
		--query "AccountAssignments[?PrincipalId=='${PRINCIPAL_ID}'] | length(@)" --output text)"
	if [ "$have" != "0" ]; then
		log "${PERMISSION_SET} is already assigned to ${PRINCIPAL_TYPE} ${PRINCIPAL_ID} on ${account_id} (reused)"
	elif [ "$DRY_RUN" = 1 ]; then
		log "DRY-RUN would assign ${PERMISSION_SET} to ${PRINCIPAL_TYPE} ${PRINCIPAL_ID} on ${account_id}"
	else
		log "assigning ${PERMISSION_SET} to ${PRINCIPAL_TYPE} ${PRINCIPAL_ID} on ${account_id}"
		areq="$(aws sso-admin create-account-assignment --instance-arn "$instance_arn" \
			--target-id "$account_id" --target-type AWS_ACCOUNT --permission-set-arn "$ps_arn" \
			--principal-type "$PRINCIPAL_TYPE" --principal-id "$PRINCIPAL_ID" \
			--query AccountAssignmentCreationStatus.RequestId --output text)"
		for _ in $(seq 1 30); do
			astate="$(aws sso-admin describe-account-assignment-creation-status --instance-arn "$instance_arn" \
				--account-assignment-creation-request-id "$areq" \
				--query 'AccountAssignmentCreationStatus.[Status,FailureReason]' --output text)"
			case "$astate" in
			SUCCEEDED*) break ;;
			FAILED*) die "assignment failed: ${astate#FAILED}" ;;
			esac
			sleep 5
		done
		log "assignment done"
	fi
fi

echo
if [ -n "$account_id" ]; then
	echo "Account ${BACKUP_ACCOUNT_NAME}: ${account_id}"
	echo "Commit this line in infra/backup-account/terraform.tfvars, and use the id in bootstrap/terraform.tfvars:"
	echo "  backup_account_id = \"${account_id}\""
else
	echo "DRY-RUN: nothing created."
fi
