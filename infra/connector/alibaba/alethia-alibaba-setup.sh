#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Keyless Alibaba Cloud connector setup — account-free (AssumeRoleWithOIDC).
#
# Alethia's control plane is its own OIDC issuer. This script registers, in YOUR Alibaba
# account, a RAM OIDC provider that trusts that issuer + a RAM role that trusts the provider.
# Alethia assumes the role by presenting a short-lived minted assertion — no Alibaba account
# on Alethia's side, no AccessKey, nothing stored but the role ARN you paste back. Parity with
# infra/connector/alibaba/main.tf (the aliyun-CLI equivalent of that Terraform module).
#
# Run in the Alibaba Cloud Shell (https://shell.aliyun.com) — the aliyun CLI + openssl are
# preinstalled and already authenticated — or locally with `aliyun` configured.

set -euo pipefail

# The Alethia control-plane OIDC issuer the role trusts. Defaults to the hosted issuer; a
# self-hosted console passes its own (ALETHIA_ISSUER_URL env or arg 1). MUST match issuerUrl()
# (lib/oidc/issuer.ts).
ISSUER_URL="${ALETHIA_ISSUER_URL:-${1:-https://alethialabs.io/api/oidc}}"
# The fixed subject + audience the Alethia issuer mints — MUST match WORKLOAD_SUBJECT
# (lib/oidc/issuer.ts) and the Alibaba session audience (session/alibaba.ts).
SUBJECT="alethia-connector"
AUDIENCE="sts.aliyuncs.com"
OIDC_PROVIDER_NAME="alethia"
ROLE_NAME="AlethiaProvisioner"
SLR_POLICY_NAME="${ROLE_NAME}-ServiceLinkedRoles"

# System RAM policies attached to the provisioning role — one per Alibaba service the project
# templates create (never AliyunRAMFullAccess). Parity with main.tf's provisioning_policies.
PROVISIONING_POLICIES=(
  AliyunCSFullAccess
  AliyunVPCFullAccess
  AliyunECSFullAccess
  AliyunSLBFullAccess
  AliyunEIPFullAccess
  AliyunRDSFullAccess
  AliyunContainerRegistryFullAccess
  AliyunKvstoreFullAccess
  AliyunDNSFullAccess
  AliyunKMSFullAccess
  AliyunMNSFullAccess
  AliyunOSSFullAccess
  AliyunOTSFullAccess
  AliyunYundunWAFFullAccess
)

for bin in aliyun openssl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: '$bin' is required (both are preinstalled in the Alibaba Cloud Shell)." >&2
    exit 1
  fi
done

echo "==> Resolving your Alibaba account id..."
ACCOUNT_ID=$(aliyun sts GetCallerIdentity 2>/dev/null | grep -o '"AccountId"[^,]*' | grep -o '[0-9]\+')
if [ -z "${ACCOUNT_ID}" ]; then
  echo "ERROR: could not read your account id (is the aliyun CLI configured?)." >&2
  exit 1
fi
echo "    Account ID: ${ACCOUNT_ID}"

# Alibaba requires the issuer cert-chain SHA1 fingerprints on the OIDC provider. Supply every
# fingerprint in the presented chain so validation succeeds regardless of which cert Alibaba pins.
echo ""
echo "==> Fetching the issuer TLS fingerprints (${ISSUER_URL})..."
ISSUER_HOST=$(printf '%s' "${ISSUER_URL}" | sed -E 's#^https?://([^/]+).*#\1#')
TMPD=$(mktemp -d)
trap 'rm -rf "${TMPD}"' EXIT
echo | openssl s_client -servername "${ISSUER_HOST}" -connect "${ISSUER_HOST}:443" -showcerts 2>/dev/null >"${TMPD}/chain.txt"
awk -v d="${TMPD}" '/-----BEGIN CERTIFICATE-----/{n++} n{print >(d"/cert"n".pem")}' "${TMPD}/chain.txt"
FINGERPRINTS=""
for cert in "${TMPD}"/cert*.pem; do
  [ -f "${cert}" ] || continue
  fp=$(openssl x509 -in "${cert}" -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g' | tr '[:upper:]' '[:lower:]')
  [ -n "${fp}" ] && FINGERPRINTS="${FINGERPRINTS:+${FINGERPRINTS},}${fp}"
done
if [ -z "${FINGERPRINTS}" ]; then
  echo "ERROR: could not read the issuer TLS fingerprints from ${ISSUER_HOST}." >&2
  exit 1
fi
echo "    Fingerprints: ${FINGERPRINTS}"

echo ""
echo "==> Creating the RAM OIDC provider '${OIDC_PROVIDER_NAME}'..."
if aliyun ims GetOIDCProvider --OIDCProviderName "${OIDC_PROVIDER_NAME}" >/dev/null 2>&1; then
  echo "    OIDC provider already exists, updating fingerprints."
  aliyun ims UpdateOIDCProvider --OIDCProviderName "${OIDC_PROVIDER_NAME}" --Fingerprints "${FINGERPRINTS}" >/dev/null
else
  aliyun ims CreateOIDCProvider \
    --OIDCProviderName "${OIDC_PROVIDER_NAME}" \
    --IssuerUrl "${ISSUER_URL}" \
    --ClientIds "${AUDIENCE}" \
    --Fingerprints "${FINGERPRINTS}" \
    --Description "Trust the Alethia control-plane OIDC issuer for keyless AssumeRoleWithOIDC." >/dev/null
  echo "    Created."
fi
OIDC_PROVIDER_ARN="acs:ram::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_NAME}"

echo ""
echo "==> Creating the RAM role '${ROLE_NAME}' (trusts the OIDC provider)..."
# Trust only Alethia's OIDC provider, and only the fixed workload subject + audience the console
# mints — a wrong sub/aud is rejected. Parity with main.tf's assume_role_policy_document.
TRUST_DOC=$(cat <<JSON
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Principal": { "Federated": ["${OIDC_PROVIDER_ARN}"] },
      "Condition": {
        "StringEquals": {
          "oidc:iss": "${ISSUER_URL}",
          "oidc:aud": "${AUDIENCE}",
          "oidc:sub": "${SUBJECT}"
        }
      }
    }
  ]
}
JSON
)
if aliyun ram GetRole --RoleName "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "    Role already exists, updating its trust policy."
  aliyun ram UpdateRole --RoleName "${ROLE_NAME}" --NewAssumeRolePolicyDocument "${TRUST_DOC}" >/dev/null
else
  aliyun ram CreateRole \
    --RoleName "${ROLE_NAME}" \
    --AssumeRolePolicyDocument "${TRUST_DOC}" \
    --Description "Role Alethia assumes via AssumeRoleWithOIDC to provision infrastructure. Keyless." >/dev/null
  echo "    Created."
fi

echo ""
echo "==> Attaching least-privilege system policies (one per provisioned service)..."
for policy in "${PROVISIONING_POLICIES[@]}"; do
  aliyun ram AttachPolicyToRole --PolicyType System --PolicyName "${policy}" --RoleName "${ROLE_NAME}" >/dev/null 2>&1 || true
done
echo "    Attached ${#PROVISIONING_POLICIES[@]} policies."

echo ""
echo "==> Creating the service-linked-role policy (ACK/NAT first-use; non-escalating)..."
# Grant ONLY ram:CreateServiceLinkedRole (+ delete for teardown) — NOT AliyunRAMFullAccess.
SLR_DOC='{"Version":"1","Statement":[{"Effect":"Allow","Action":["ram:CreateServiceLinkedRole","ram:DeleteServiceLinkedRole","ram:GetServiceLinkedRoleDeletionStatus"],"Resource":"*"}]}'
if ! aliyun ram GetPolicy --PolicyType Custom --PolicyName "${SLR_POLICY_NAME}" >/dev/null 2>&1; then
  aliyun ram CreatePolicy \
    --PolicyName "${SLR_POLICY_NAME}" \
    --PolicyDocument "${SLR_DOC}" \
    --Description "Narrow: only service-linked-role creation for ACK/NAT — no policy-attach escalation." >/dev/null
fi
aliyun ram AttachPolicyToRole --PolicyType Custom --PolicyName "${SLR_POLICY_NAME}" --RoleName "${ROLE_NAME}" >/dev/null 2>&1 || true
echo "    Ready."

ROLE_ARN="acs:ram::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo ""
echo "============================================================"
echo "  Setup complete! (keyless, account-free OIDC)"
echo "============================================================"
echo ""
echo "Copy this value into the Alethia dashboard:"
echo ""
echo "  RAM Role ARN: ${ROLE_ARN}"
echo ""
echo "--- START CONFIG (machine-readable, parsed by the Alethia CLI) ---"
echo "role_arn=${ROLE_ARN}"
echo "oidc_provider_arn=${OIDC_PROVIDER_ARN}"
echo "--- END CONFIG ---"
