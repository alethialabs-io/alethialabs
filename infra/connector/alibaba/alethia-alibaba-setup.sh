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

# Enumerated least-privilege CUSTOM policies (no service:*) — parity with main.tf locals
# (provisioning_custom_policies). Each validated via aliyun ram CreatePolicy. Bucket -> policy doc.
POLICY_COMPUTECLUSTER='{"Version":"1","Statement":[{"Effect":"Allow","Action":["cs:CreateCluster","cs:DeleteCluster","cs:ModifyCluster","cs:ModifyClusterConfiguration","cs:UpgradeCluster","cs:MigrateCluster","cs:CreateClusterNodePool","cs:ModifyClusterNodePool","cs:DeleteClusterNodePool","cs:ScaleClusterNodePool","cs:RepairClusterNodePool","cs:AttachInstances","cs:GrantPermissions","cs:TagResources","cs:UntagResources","cs:Describe*","cs:Get*","cs:List*","cs:CheckControlPlaneLogEnable","ecs:RunInstances","ecs:CreateInstance","ecs:DeleteInstance","ecs:DeleteInstances","ecs:StartInstance","ecs:StopInstance","ecs:StopInstances","ecs:ModifyInstanceAttribute","ecs:ModifyInstanceSpec","ecs:ReplaceSystemDisk","ecs:CreateSecurityGroup","ecs:DeleteSecurityGroup","ecs:AuthorizeSecurityGroup","ecs:AuthorizeSecurityGroupEgress","ecs:RevokeSecurityGroup","ecs:RevokeSecurityGroupEgress","ecs:ModifySecurityGroupPolicy","ecs:CreateDisk","ecs:DeleteDisk","ecs:AttachDisk","ecs:DetachDisk","ecs:ResizeDisk","ecs:CreateNetworkInterface","ecs:DeleteNetworkInterface","ecs:AttachNetworkInterface","ecs:DetachNetworkInterface","ecs:CreateKeyPair","ecs:ImportKeyPair","ecs:DeleteKeyPairs","ecs:AttachKeyPair","ecs:CreateLaunchTemplate","ecs:CreateLaunchTemplateVersion","ecs:DeleteLaunchTemplate","ecs:TagResources","ecs:UntagResources","ecs:Describe*","ecs:List*","slb:CreateLoadBalancer","slb:DeleteLoadBalancer","slb:ModifyLoadBalancerInstanceSpec","slb:ModifyLoadBalancerInternetSpec","slb:SetLoadBalancerName","slb:CreateLoadBalancerTCPListener","slb:CreateLoadBalancerUDPListener","slb:CreateLoadBalancerHTTPListener","slb:CreateLoadBalancerHTTPSListener","slb:DeleteLoadBalancerListener","slb:StartLoadBalancerListener","slb:StopLoadBalancerListener","slb:SetLoadBalancerTCPListenerAttribute","slb:AddBackendServers","slb:RemoveBackendServers","slb:SetBackendServers","slb:AddVServerGroupBackendServers","slb:CreateVServerGroup","slb:DeleteVServerGroup","slb:ModifyVServerGroupBackendServers","slb:TagResources","slb:UntagResources","slb:Describe*","slb:List*"],"Resource":"*"}]}'
POLICY_NETWORK='{"Version":"1","Statement":[{"Effect":"Allow","Action":["vpc:CreateVpc","vpc:DeleteVpc","vpc:ModifyVpcAttribute","vpc:CreateVSwitch","vpc:DeleteVSwitch","vpc:ModifyVSwitchAttribute","vpc:CreateNatGateway","vpc:DeleteNatGateway","vpc:ModifyNatGatewayAttribute","vpc:CreateSnatEntry","vpc:DeleteSnatEntry","vpc:ModifySnatEntry","vpc:CreateRouteEntry","vpc:DeleteRouteEntry","vpc:AssociateRouteTable","vpc:TagResources","vpc:UnTagResources","vpc:Describe*","vpc:List*","vpc:Get*","vpc:AllocateEipAddress","vpc:ReleaseEipAddress","vpc:AssociateEipAddress","vpc:UnassociateEipAddress","vpc:ModifyEipAddressAttribute","vpc:DescribeEipAddresses","eip:AllocateEipAddress","eip:ReleaseEipAddress","eip:AssociateEipAddress","eip:UnassociateEipAddress","eip:ModifyEipAddressAttribute","eip:TagResources","eip:UnTagResources","eip:DescribeEipAddresses","eip:Describe*","eip:List*"],"Resource":"*"}]}'
POLICY_DATA='{"Version":"1","Statement":[{"Effect":"Allow","Action":["rds:CreateDBInstance","rds:DeleteDBInstance","rds:ModifyDBInstanceSpec","rds:ModifyDBInstanceConnectionString","rds:AllocateInstancePublicConnection","rds:ModifySecurityIps","rds:CreateDatabase","rds:DeleteDatabase","rds:CreateAccount","rds:DeleteAccount","rds:ResetAccountPassword","rds:ModifyAccountDescription","rds:GrantAccountPrivilege","rds:RevokeAccountPrivilege","rds:ModifyBackupPolicy","rds:ModifyDBInstanceMaintainTime","rds:TagResources","rds:UntagResources","rds:Describe*","rds:List*","kvstore:CreateInstance","kvstore:DeleteInstance","kvstore:ModifyInstanceSpec","kvstore:ModifyInstanceAttribute","kvstore:ModifyInstanceMaintainTime","kvstore:ModifySecurityIps","kvstore:ModifyInstanceConnection","kvstore:AllocateInstancePublicConnection","kvstore:ResetAccountPassword","kvstore:TagResources","kvstore:UntagResources","kvstore:Describe*","kvstore:List*","oss:PutBucket","oss:PutBucketAcl","oss:PutBucketVersioning","oss:PutBucketTagging","oss:PutBucketLogging","oss:PutBucketEncryption","oss:DeleteBucket","oss:DeleteBucketTagging","oss:GetBucketInfo","oss:GetBucketAcl","oss:GetBucketVersioning","oss:GetBucketTagging","oss:GetBucketLocation","oss:GetBucketStat","oss:ListBuckets","oss:GetObject","oss:PutObject","oss:DeleteObject","oss:ListObjects","oss:AbortMultipartUpload","ots:CreateInstance","ots:DeleteInstance","ots:UpdateInstance","ots:GetInstance","ots:ListInstance","ots:InsertInstanceTag","ots:DeleteInstanceTag","ots:CreateTable","ots:DeleteTable","ots:UpdateTable","ots:DescribeTable","ots:ListTable","ots:Get*","ots:List*","ots:Describe*","kms:CreateSecret","kms:UpdateSecret","kms:PutSecretValue","kms:GetSecretValue","kms:UpdateSecretVersionStage","kms:DeleteSecret","kms:RestoreSecret","kms:TagResource","kms:UntagResource","kms:DescribeSecret","kms:ListSecrets","kms:ListSecretVersionIds","kms:Describe*","kms:List*","kms:Get*"],"Resource":"*"}]}'
POLICY_EDGEREG='{"Version":"1","Statement":[{"Effect":"Allow","Action":["cr:CreateInstance","cr:GetInstance","cr:GetInstanceEndpoint","cr:ListInstance","cr:ListInstanceEndpoint","cr:CreateNamespace","cr:UpdateNamespace","cr:DeleteNamespace","cr:GetNamespace","cr:ListNamespace","cr:CreateInstanceVpcEndpointLinkedVpc","cr:TagResources","cr:UntagResources","cr:Get*","cr:List*","alidns:AddDomain","alidns:DeleteDomain","alidns:ChangeDomainGroup","alidns:UpdateDomainRemark","alidns:AddDomainRecord","alidns:UpdateDomainRecord","alidns:DeleteDomainRecord","alidns:SetDomainRecordStatus","alidns:TagResources","alidns:UntagResources","alidns:Describe*","alidns:List*","alidns:Get*","mns:CreateQueue","mns:DeleteQueue","mns:SetQueueAttributes","mns:GetQueueAttributes","mns:ListQueue","mns:CreateTopic","mns:DeleteTopic","mns:SetTopicAttributes","mns:GetTopicAttributes","mns:ListTopic","mns:TagResources","mns:UntagResources","mns:Get*","mns:List*","yundun-waf:CreateInstance","yundun-waf:DeleteInstance","yundun-waf:ModifyInstance","yundun-waf:DescribeInstance","yundun-waf:DescribeInstanceInfo","yundun-waf:DescribeInstanceSpecInfo","yundun-waf:Describe*","yundun-waf:Get*","yundun-waf:List*"],"Resource":"*"}]}'

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

# Alibaba pins the issuer's TLS cert-chain SHA1 fingerprints on the OIDC provider. We register the
# CA certs (the intermediate + root — every cert in the presented chain EXCEPT the leaf), NOT the leaf:
# alethialabs.io is fronted by a Cloudflare tunnel whose LEAF cert rotates frequently, so a leaf-pinned
# provider would silently stop validating after a rotation, whereas the issuing CA is stable for months/
# years. If the chain has only one cert (no intermediate presented), fall back to pinning it. When the CA
# itself eventually rotates, the fix is to RE-RUN this script (idempotent — it UpdateOIDCProviders the
# fingerprints); the keyless console cannot refresh them itself (it has no standing Alibaba credential).
echo ""
echo "==> Fetching the issuer CA fingerprints (${ISSUER_URL})..."
ISSUER_HOST=$(printf '%s' "${ISSUER_URL}" | sed -E 's#^https?://([^/]+).*#\1#')
TMPD=$(mktemp -d)
trap 'rm -rf "${TMPD}"' EXIT
echo | openssl s_client -servername "${ISSUER_HOST}" -connect "${ISSUER_HOST}:443" -showcerts 2>/dev/null >"${TMPD}/chain.txt"
awk -v d="${TMPD}" '/-----BEGIN CERTIFICATE-----/{n++} n{print >(d"/cert"n".pem")}' "${TMPD}/chain.txt"
# Count the certs in the presented chain (cert1 = leaf, cert2..N = intermediate/root CAs).
CERT_COUNT=$(ls "${TMPD}"/cert*.pem 2>/dev/null | wc -l | tr -d ' ')
FINGERPRINTS=""
for cert in "${TMPD}"/cert*.pem; do
  [ -f "${cert}" ] || continue
  # Skip the leaf (cert1) when the chain also presents CA certs — pin only the stable CA(s).
  if [ "${CERT_COUNT}" -gt 1 ] && [ "${cert}" = "${TMPD}/cert1.pem" ]; then
    continue
  fi
  fp=$(openssl x509 -in "${cert}" -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g' | tr '[:upper:]' '[:lower:]')
  [ -n "${fp}" ] && FINGERPRINTS="${FINGERPRINTS:+${FINGERPRINTS},}${fp}"
done
if [ -z "${FINGERPRINTS}" ]; then
  echo "ERROR: could not read the issuer TLS fingerprints from ${ISSUER_HOST}." >&2
  exit 1
fi
echo "    CA fingerprints: ${FINGERPRINTS}"

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
echo "==> Creating + attaching the enumerated least-privilege custom policies..."
# Upsert each custom policy (create if absent, else roll a new default version) then attach it. These
# replace the per-service System *FullAccess policies with enumerated action sets.
upsert_policy() {
  local name="$1" doc="$2"
  if aliyun ram GetPolicy --PolicyType Custom --PolicyName "${name}" >/dev/null 2>&1; then
    aliyun ram CreatePolicyVersion --PolicyName "${name}" --PolicyDocument "${doc}" \
      --SetAsDefault true --RotateExistingVersions true >/dev/null 2>&1 || true
  else
    aliyun ram CreatePolicy --PolicyName "${name}" --PolicyDocument "${doc}" \
      --Description "Enumerated least-priv (no service:*) for the Alethia provisioner." >/dev/null
  fi
  aliyun ram AttachPolicyToRole --PolicyType Custom --PolicyName "${name}" --RoleName "${ROLE_NAME}" >/dev/null 2>&1 || true
  echo "    ${name} ready + attached."
}
upsert_policy "${ROLE_NAME}-ComputeCluster" "${POLICY_COMPUTECLUSTER}"
upsert_policy "${ROLE_NAME}-Network"        "${POLICY_NETWORK}"
upsert_policy "${ROLE_NAME}-Data"           "${POLICY_DATA}"
upsert_policy "${ROLE_NAME}-EdgeReg"        "${POLICY_EDGEREG}"

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
