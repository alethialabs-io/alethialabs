#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# One-time (idempotent) population of the prod secret vault in AWS Secrets Manager.
# Generates the INTERNAL secrets (only if absent — never rotates from here) and merges
# the EXTERNALS you provide in a local, untracked file into the single JSON secret
# `alethia/prod/env`. CI then reads that secret via OIDC; nothing lands in GitHub.
#
# Run locally with AWS admin creds (the same identity that applies infra/aws-oidc),
# AFTER `infra/aws-oidc` has created the secret container. Safe to re-run.
#
#   cp deploy/prod/secrets.local.env.example deploy/prod/secrets.local.env  # fill it
#   ./scripts/bootstrap-secrets.sh
#
# Env knobs: SECRET_ID (default alethia/prod/env), AWS_REGION (default eu-central-1),
#            EXT_FILE (default deploy/prod/secrets.local.env).
set -euo pipefail

SECRET_ID="${SECRET_ID:-alethia/prod/env}"
REGION="${AWS_REGION:-eu-central-1}"
EXT_FILE="${EXT_FILE:-deploy/prod/secrets.local.env}"

for bin in aws jq openssl; do
  command -v "$bin" >/dev/null || { echo "error: '$bin' is required" >&2; exit 1; }
done

# Current secret JSON (empty object if the container has no value yet / bad JSON).
current="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text 2>/dev/null || true)"
if [ -z "$current" ] || [ "$current" = "None" ] || ! printf '%s' "$current" | jq empty >/dev/null 2>&1; then
  current='{}'
fi
merged="$current"

# Generate an internal secret only if the key is missing/empty (idempotent).
gen_if_absent() {
  local key="$1" val="$2" have
  have="$(printf '%s' "$merged" | jq -r --arg k "$key" '.[$k] // ""')"
  if [ -z "$have" ]; then
    merged="$(printf '%s' "$merged" | jq --arg k "$key" --arg v "$val" '.[$k]=$v')"
    echo "+ generated $key"
  else
    echo "· kept     $key"
  fi
}
b64() { openssl rand -base64 32; }   # 32 bytes → AES-256 key / auth secret
hex() { openssl rand -hex 32; }      # 64-char hex token
# base64(PKCS8 RSA-2048 PEM) on ONE line — the workload-identity OIDC issuer signing key
# (lib/oidc/issuer.ts). Asymmetric so clouds verify via the published JWKS; never shared.
rsa_b64() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl base64 -A; }

gen_if_absent BETTER_AUTH_SECRET "$(b64)"
gen_if_absent CLI_JWT_SECRET "$(hex)"
gen_if_absent ALETHIA_CRED_ENCRYPTION_KEY "$(b64)"   # base64, decodes to 32 bytes
gen_if_absent ALETHIA_SNAPSHOT_HMAC_KEY "$(b64)"     # config_snapshot HMAC (lib/runners/snapshot-sig.ts)
gen_if_absent ALETHIA_DB_PASSWORD "$(hex)"
gen_if_absent ALETHIA_APP_DB_PASSWORD "$(hex)"
gen_if_absent OPENFGA_DB_PASSWORD "$(hex)"
gen_if_absent ALETHIA_STORAGE_ACCESS_KEY_ID "$(hex)"
gen_if_absent ALETHIA_STORAGE_SECRET_ACCESS_KEY "$(b64)"
gen_if_absent ALETHIA_RUNNER_BOOTSTRAP_TOKEN "$(hex)"
gen_if_absent ALETHIA_CRON_SECRET "$(hex)"
gen_if_absent RELEASE_API_SECRET "$(hex)"
# Dedicated bearer between apps/admin (operator plane) and the console provisioning routes — a
# DISTINCT secret from ALETHIA_CRON_SECRET (minting orgs / granting ownership is higher blast
# radius than a sweep). Both containers read the same assembled .env, so one shared value works.
gen_if_absent PLATFORM_PROVISION_SECRET "$(hex)"
gen_if_absent ALETHIA_OIDC_SIGNING_KEY "$(rsa_b64)"
# Next.js Server Actions encryption key — shared by console/admin/marketing (all read the same
# assembled .env). Unset ⇒ Next generates a RANDOM key per `next build`, so a user with a page open
# across a deploy gets "Server Action was not found on the server" (the action reference minted by
# the old build can't be validated by the new one). A stable value kills that skew. base64 → 32-byte
# AES key. NEVER rotate casually — rotating forces every open tab to hard-reload once.
gen_if_absent NEXT_SERVER_ACTIONS_ENCRYPTION_KEY "$(b64)"

# Merge externals (KEY=VALUE lines) — these OVERRIDE, so editing the file + re-running
# updates them. Do NOT quote values in the file; everything after the first '=' is the value.
if [ -f "$EXT_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue;; esac
    key="$(printf '%s' "${line%%=*}" | tr -d '[:space:]')"
    val="${line#*=}"
    # Strip a dotenv-style inline comment and surrounding whitespace: a '#' PRECEDED BY WHITESPACE
    # (` # note`) is a comment and is dropped; a '#' with no leading space is kept (it may be part of
    # the value, e.g. a password `p#ss`). Also trims leading/trailing whitespace. Without this, a
    # commented value line like `HCLOUD_TOKEN=abc   # runtime token` carried the comment verbatim into
    # the vault, which then broke the token (401) and HCLOUD_SSH_KEYS (404) on the box.
    val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -z "$key" ] && continue
    merged="$(printf '%s' "$merged" | jq --arg k "$key" --arg v "$val" '.[$k]=$v')"
    echo "= external $key"
  done < "$EXT_FILE"
else
  echo "WARN: $EXT_FILE not found — externals not merged (internals only)." >&2
fi

# CI→box deploy SSH keypair. You never type this: if the vault has no private key we
# GENERATE an ed25519 pair and store BOTH the private and public key. (Bring-your-own:
# point DEPLOY_SSH_KEY_FILE at an existing private key to import it instead.)
have_ssh="$(printf '%s' "$merged" | jq -r '.DEPLOY_SSH_PRIVATE_KEY // ""')"
if [ -n "${DEPLOY_SSH_KEY_FILE:-}" ] && [ -f "${DEPLOY_SSH_KEY_FILE}" ]; then
  priv="$(cat "$DEPLOY_SSH_KEY_FILE")"
  pub="$(ssh-keygen -y -f "$DEPLOY_SSH_KEY_FILE" 2>/dev/null || cat "${DEPLOY_SSH_KEY_FILE}.pub" 2>/dev/null || echo "")"
  merged="$(printf '%s' "$merged" | jq --arg p "$priv" --arg q "$pub" '.DEPLOY_SSH_PRIVATE_KEY=$p | (if $q != "" then .DEPLOY_SSH_PUBLIC_KEY=$q else . end)')"
  echo "= imported DEPLOY_SSH_PRIVATE_KEY (from file)"
elif [ -z "$have_ssh" ]; then
  kt="$(mktemp -d)"
  ssh-keygen -t ed25519 -N "" -C "alethia-deploy" -f "$kt/id" >/dev/null
  priv="$(cat "$kt/id")"; pub="$(cat "$kt/id.pub")"
  merged="$(printf '%s' "$merged" | jq --arg p "$priv" --arg q "$pub" '.DEPLOY_SSH_PRIVATE_KEY=$p | .DEPLOY_SSH_PUBLIC_KEY=$q')"
  rm -rf "$kt"; kt=""
  echo "+ generated DEPLOY_SSH_PRIVATE_KEY + DEPLOY_SSH_PUBLIC_KEY (ed25519)"
else
  echo "· kept     DEPLOY_SSH_PRIVATE_KEY"
fi

# Write back atomically via a temp file (avoids secrets on the command line).
tmp="$(mktemp)"; trap 'rm -f "$tmp"; rm -rf "${kt:-}"' EXIT
printf '%s' "$merged" | jq -S . > "$tmp"
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --secret-string "file://$tmp" >/dev/null
echo "Wrote $(jq 'keys|length' "$tmp") keys to $SECRET_ID ($REGION)."
