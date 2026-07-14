#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Keyless AWS connector setup — direct OIDC federation, no external id, no platform AWS account.
#
# Registers, in YOUR AWS account, an IAM OIDC identity provider that trusts the Alethia issuer +
# an IAM role (AlethiaProvisionerRole) that role-trusts it, scoped to the fixed workload subject +
# audience the console mints. Alethia assumes the role via AssumeRoleWithWebIdentity with a
# short-lived minted assertion — nothing stored but the role ARN you paste back. Parity with
# infra/connector/aws/alethia-bootstrap.tf (the aws-CLI equivalent of that module / the CFN template).
#
# Run in AWS CloudShell (https://console.aws.amazon.com/cloudshell) — the aws CLI + openssl are
# preinstalled and already authenticated — or locally with `aws` configured.

set -euo pipefail

# The Alethia control-plane OIDC issuer this account trusts. Defaults to the hosted issuer; a
# self-hosted console passes its own (ALETHIA_ISSUER_URL env or arg 1). MUST match issuerUrl()
# (lib/oidc/issuer.ts).
ISSUER_URL="${ALETHIA_ISSUER_URL:-${1:-https://alethialabs.io/api/oidc}}"
# The fixed subject + audience the Alethia issuer mints — MUST match WORKLOAD_SUBJECT
# (lib/oidc/issuer.ts) and the AWS session audience.
AUDIENCE="sts.amazonaws.com"
SUBJECT="alethia-connector"
ROLE_NAME="AlethiaProvisionerRole"
OIDC_HOST="${ISSUER_URL#https://}"

for bin in aws openssl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: '$bin' is required (both are preinstalled in AWS CloudShell)." >&2
    exit 1
  fi
done

echo "==> Resolving your AWS account id..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "    Account ID: ${ACCOUNT_ID}"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"

# AWS requires a thumbprint on the OIDC provider (no longer used for a well-known-CA issuer, but the API
# demands it) — the SHA1 fingerprint of the issuer's root/last cert in the presented chain.
echo ""
echo "==> Fetching the issuer TLS thumbprint (${ISSUER_URL})..."
ISSUER_HOST=$(printf '%s' "${OIDC_HOST}" | sed -E 's#/.*##')
TMPD=$(mktemp -d)
trap 'rm -rf "${TMPD}"' EXIT
echo | openssl s_client -servername "${ISSUER_HOST}" -connect "${ISSUER_HOST}:443" -showcerts 2>/dev/null >"${TMPD}/chain.txt"
awk -v d="${TMPD}" '/-----BEGIN CERTIFICATE-----/{n++} n{print >(d"/cert"n".pem")}' "${TMPD}/chain.txt"
LAST_CERT=$(find "${TMPD}" -name 'cert*.pem' | sort | tail -1)
THUMBPRINT=$(openssl x509 -in "${LAST_CERT}" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr '[:upper:]' '[:lower:]')
if [ -z "${THUMBPRINT}" ]; then
  echo "ERROR: could not read the issuer TLS thumbprint from ${ISSUER_HOST}." >&2
  exit 1
fi
echo "    Thumbprint: ${THUMBPRINT}"

echo ""
echo "==> Creating the IAM OIDC identity provider..."
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${OIDC_ARN}" >/dev/null 2>&1; then
  echo "    OIDC provider already exists, skipping."
else
  aws iam create-open-id-connect-provider \
    --url "${ISSUER_URL}" \
    --client-id-list "${AUDIENCE}" \
    --thumbprint-list "${THUMBPRINT}" >/dev/null
  echo "    Created."
fi

echo ""
echo "==> Creating the IAM role ${ROLE_NAME} (trusts the OIDC provider)..."
TRUST_DOC="${TMPD}/trust.json"
cat >"${TRUST_DOC}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_HOST}:aud": "${AUDIENCE}",
          "${OIDC_HOST}:sub": "${SUBJECT}"
        }
      }
    }
  ]
}
JSON
if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "    Role already exists, updating its trust policy."
  aws iam update-assume-role-policy --role-name "${ROLE_NAME}" --policy-document "file://${TRUST_DOC}" >/dev/null
else
  aws iam create-role --role-name "${ROLE_NAME}" --assume-role-policy-document "file://${TRUST_DOC}" >/dev/null
  echo "    Created."
fi

# Least-privilege provisioning policies (replace AdministratorAccess) — scoped to exactly the services
# the project templates create. Parity with the four scoped policies in alethia-bootstrap.tf.
cat >"${TMPD}/compute.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "ComputeClusterNetworkScaling",
    "Effect": "Allow",
    "Action": ["ec2:*","eks:*","autoscaling:*","application-autoscaling:*","elasticloadbalancing:*","events:*","cloudwatch:*","pricing:GetProducts","tag:GetResources","tag:GetTagKeys","tag:GetTagValues"],
    "Resource": "*"
  }]
}
JSON
cat >"${TMPD}/data.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DataSecretsMessagingRegistry",
    "Effect": "Allow",
    "Action": ["rds:*","elasticache:*","dynamodb:*","s3:*","ecr:*","secretsmanager:*","kms:*","sqs:*","sns:*","ssm:*"],
    "Resource": "*"
  }]
}
JSON
cat >"${TMPD}/edge.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DnsCertsWafLogs",
    "Effect": "Allow",
    "Action": ["route53:*","route53domains:ListDomains","acm:*","wafv2:*","logs:*","firehose:*"],
    "Resource": "*"
  }]
}
JSON
cat >"${TMPD}/iam.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IamManageProvisionedPrincipals",
      "Effect": "Allow",
      "Action": ["iam:CreateRole","iam:DeleteRole","iam:GetRole","iam:UpdateRole","iam:TagRole","iam:UntagRole","iam:UpdateAssumeRolePolicy","iam:PutRolePolicy","iam:DeleteRolePolicy","iam:GetRolePolicy","iam:AttachRolePolicy","iam:DetachRolePolicy","iam:ListRolePolicies","iam:ListAttachedRolePolicies","iam:ListRoleTags","iam:CreatePolicy","iam:DeletePolicy","iam:GetPolicy","iam:CreatePolicyVersion","iam:DeletePolicyVersion","iam:GetPolicyVersion","iam:ListPolicyVersions","iam:ListPolicies","iam:CreateInstanceProfile","iam:DeleteInstanceProfile","iam:GetInstanceProfile","iam:AddRoleToInstanceProfile","iam:RemoveRoleFromInstanceProfile","iam:TagInstanceProfile","iam:CreateOpenIDConnectProvider","iam:DeleteOpenIDConnectProvider","iam:GetOpenIDConnectProvider","iam:TagOpenIDConnectProvider","iam:UpdateOpenIDConnectProviderThumbprint","iam:AddClientIDToOpenIDConnectProvider","iam:CreateUser","iam:DeleteUser","iam:GetUser","iam:TagUser","iam:PutUserPolicy","iam:DeleteUserPolicy","iam:GetUserPolicy","iam:ListUserPolicies","iam:AttachUserPolicy","iam:DetachUserPolicy","iam:CreateAccessKey","iam:DeleteAccessKey","iam:ListAccessKeys","iam:ListInstanceProfilesForRole"],
      "Resource": "*"
    },
    {
      "Sid": "PassRoleToProvisionedServices",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "*",
      "Condition": { "StringEquals": { "iam:PassedToService": ["eks.amazonaws.com","ec2.amazonaws.com","rds.amazonaws.com","monitoring.rds.amazonaws.com","elasticache.amazonaws.com","firehose.amazonaws.com","application-autoscaling.amazonaws.com"] } }
    },
    {
      "Sid": "CreateServiceLinkedRolesForProvisionedServices",
      "Effect": "Allow",
      "Action": "iam:CreateServiceLinkedRole",
      "Resource": "*",
      "Condition": { "StringEquals": { "iam:AWSServiceName": ["eks.amazonaws.com","eks-nodegroup.amazonaws.com","spot.amazonaws.com","elasticache.amazonaws.com","rds.amazonaws.com","elasticloadbalancing.amazonaws.com"] } }
    },
    {
      "Sid": "DenyAttachAdminGradePolicies",
      "Effect": "Deny",
      "Action": ["iam:AttachRolePolicy","iam:AttachUserPolicy","iam:PutRolePolicy","iam:PutUserPolicy"],
      "Resource": "*",
      "Condition": { "ArnEquals": { "iam:PolicyARN": ["arn:aws:iam::aws:policy/AdministratorAccess","arn:aws:iam::aws:policy/IAMFullAccess","arn:aws:iam::aws:policy/PowerUserAccess"] } }
    },
    {
      "Sid": "DenyOrgAndAccountControl",
      "Effect": "Deny",
      "Action": ["organizations:*","account:*","iam:CreateAccountAlias","iam:DeleteAccountAlias"],
      "Resource": "*"
    }
  ]
}
JSON

echo ""
echo "==> Creating + attaching the four least-privilege policies..."
for scope in compute data edge iam; do
  case "${scope}" in
    compute) suffix="Compute" ;;
    data) suffix="Data" ;;
    edge) suffix="Edge" ;;
    iam) suffix="IAM" ;;
  esac
  policy_name="${ROLE_NAME}-${suffix}"
  policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${policy_name}"
  if ! aws iam get-policy --policy-arn "${policy_arn}" >/dev/null 2>&1; then
    aws iam create-policy --policy-name "${policy_name}" --policy-document "file://${TMPD}/${scope}.json" >/dev/null
  fi
  aws iam attach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${policy_arn}" >/dev/null
  echo "    ${policy_name} attached."
done

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo ""
echo "============================================================"
echo "  Setup complete! (keyless, direct-OIDC)"
echo "============================================================"
echo ""
echo "Copy this value into the Alethia dashboard:"
echo ""
echo "  IAM Role ARN: ${ROLE_ARN}"
echo ""
echo "--- START CONFIG (machine-readable, parsed by the Alethia CLI) ---"
echo "role_arn=${ROLE_ARN}"
echo "--- END CONFIG ---"
