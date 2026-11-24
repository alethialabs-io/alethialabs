#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Step 3: mint console-books-writer's access key and MERGE it into the production vault
# `alethia/prod/env` (eu-central-1, Alethia platform account — the same secret the `prod-env` profile
# of `pnpm creds` reads) as BOOKS_ARCHIVE_ACCESS_KEY_ID / BOOKS_ARCHIVE_SECRET_ACCESS_KEY. Every other
# key in the vault is kept as it is. Modelled on infra/backup-account/ops/03-mint-writer-key.sh.
#
#   mint-console-writer-key.sh [--sso-profile alethia-sso] [--vault-profile alethia-sso] \
#       [--rotate] [--dry-run]
#
#   --sso-profile    platform SSO profile that may assume alethia-backup-admin (default alethia-sso)
#   --vault-profile  profile that may read and write alethia/prod/env (default: --sso-profile)
#   --rotate         mint a NEW key even though one exists (yearly rotation). The old key is left in
#                    place: deleting it, once the console runs on the new one, is the maintainer's.
#   --dry-run        check everything, create nothing, write nothing
#
# Idempotent: if the vault already holds a key id that is an ACTIVE key of console-books-writer, it
# says so and exits 0 without minting. The secret access key is never printed, never on a command
# line, never in the environment, and exists on disk only in a 0600 file inside a 0700 temp dir that
# is removed on exit. Only the last four characters of the key ID are ever shown.
#
# Never add `set -x`.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SSO_PROFILE="alethia-sso"
VAULT_PROFILE=""
ROTATE=0

while [ $# -gt 0 ]; do
	case "$1" in
	--sso-profile) SSO_PROFILE="${2:?}"; shift 2 ;;
	--vault-profile) VAULT_PROFILE="${2:?}"; shift 2 ;;
	--rotate) ROTATE=1; shift ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '5,23p' "$0"; exit 0 ;;
	*) die "unknown argument: $1 (see --help)" ;;
	esac
done

require_cmd aws jq
VAULT_PROFILE="${VAULT_PROFILE:-$SSO_PROFILE}"
ACCOUNT_ID="$(resolve_account_id)"

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Runs aws against the VAULT (platform account), whatever archive-account session is exported.
vault_aws() {
	env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
		AWS_PROFILE="$VAULT_PROFILE" aws --region "$VAULT_REGION" "$@"
}

# 1. The vault: it must exist and be a JSON object. Read into a 0600 file, never to the terminal.
vault_account="$(vault_aws sts get-caller-identity --query Account --output text)"
[ "$vault_account" = "$PLATFORM_ACCOUNT_ID" ] || die "--vault-profile ${VAULT_PROFILE} is account ${vault_account}, not the platform account ${PLATFORM_ACCOUNT_ID}"
vault_aws secretsmanager get-secret-value --secret-id "$VAULT_ASM_SECRET_ID" --query SecretString --output text >"$WORK/vault.json" ||
	die "could not read ${VAULT_ASM_SECRET_ID}"
jq -e 'type == "object"' "$WORK/vault.json" >/dev/null || die "${VAULT_ASM_SECRET_ID} is not a JSON object; refusing to rewrite it"
vault_key_id="$(jq -r --arg k "$VAULT_KEY_ID_VAR" '.[$k] // ""' "$WORK/vault.json")"
log "vault ${VAULT_ASM_SECRET_ID} read ($(jq 'length' "$WORK/vault.json") keys)"

# 2. The writer's existing keys, as the archive account's admin.
assume_archive_admin "$SSO_PROFILE" "$ACCOUNT_ID"
aws iam get-user --user-name "$WRITER_USER_NAME" >/dev/null 2>&1 ||
	die "${WRITER_USER_NAME} does not exist in ${ACCOUNT_ID} — apply the stack first (ops/plan.sh, ops/apply-saved-plan.sh)"
aws iam list-access-keys --user-name "$WRITER_USER_NAME" --query 'AccessKeyMetadata[].[AccessKeyId,Status]' --output text >"$WORK/keys.txt"
key_count="$(grep -c . "$WORK/keys.txt" || true)"

if [ -n "$vault_key_id" ] && grep -q "^${vault_key_id}[[:space:]]Active$" "$WORK/keys.txt" && [ "$ROTATE" = 0 ]; then
	log "the vault already holds active key …${vault_key_id: -4} of ${WRITER_USER_NAME}; nothing to do (use --rotate to replace it)"
	exit 0
fi
if [ "$key_count" -ge 1 ] && [ "$ROTATE" = 0 ]; then
	die "${WRITER_USER_NAME} already has ${key_count} key(s), none of them the vault's. Pass --rotate to mint another, or have the maintainer remove the stray key first."
fi
[ "$key_count" -lt 2 ] || die "${WRITER_USER_NAME} already has 2 keys (the IAM maximum). The maintainer must remove the one the console no longer uses first."

if [ "$DRY_RUN" = 1 ]; then
	log "DRY-RUN would create an access key for ${WRITER_USER_NAME} and merge ${VAULT_KEY_ID_VAR} / ${VAULT_SECRET_VAR} into ${VAULT_ASM_SECRET_ID}"
	exit 0
fi

# 3. Mint. The CLI's JSON goes straight to a 0600 file.
aws iam create-access-key --user-name "$WRITER_USER_NAME" --output json >"$WORK/key.json"
new_id="$(jq -r .AccessKey.AccessKeyId "$WORK/key.json")"
log "minted key …${new_id: -4} for ${WRITER_USER_NAME}"

# 4. Merge into the vault JSON, file to file: the secret never appears in argv or the environment.
jq --slurpfile k "$WORK/key.json" --arg idv "$VAULT_KEY_ID_VAR" --arg sv "$VAULT_SECRET_VAR" \
	'. + {($idv): $k[0].AccessKey.AccessKeyId, ($sv): $k[0].AccessKey.SecretAccessKey}' \
	"$WORK/vault.json" >"$WORK/vault.new.json"
before="$(jq 'length' "$WORK/vault.json")"
after="$(jq 'length' "$WORK/vault.new.json")"
[ "$after" -ge "$before" ] || die "merge lost keys (${before} → ${after}); vault NOT written. Key …${new_id: -4} exists unrecorded — the maintainer should remove it."
if ! vault_aws secretsmanager put-secret-value --secret-id "$VAULT_ASM_SECRET_ID" \
	--secret-string "file://$WORK/vault.new.json" >/dev/null; then
	die "vault write failed. Key …${new_id: -4} exists unrecorded — re-run with --rotate after fixing access, and have the maintainer remove that key."
fi
log "merged into ${VAULT_ASM_SECRET_ID} (${before} → ${after} keys)"

cat <<EOF

Done. The console reads ${VAULT_KEY_ID_VAR} / ${VAULT_SECRET_VAR} from the vault like every other
production secret. The non-secret values (bucket, region, prefix, key ARN) come from:
  cd infra/books-archive && tofu output console_env
EOF
