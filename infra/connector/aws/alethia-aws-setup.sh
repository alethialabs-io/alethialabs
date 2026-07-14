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
cat >"${TMPD}/compute_net.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "ComputeClusterNetworking",
    "Effect": "Allow",
    "Action": ["ec2:Describe*","ec2:Get*","ec2:CreateVpc","ec2:DeleteVpc","ec2:ModifyVpcAttribute","ec2:AssociateVpcCidrBlock","ec2:DisassociateVpcCidrBlock","ec2:CreateSubnet","ec2:DeleteSubnet","ec2:ModifySubnetAttribute","ec2:CreateRouteTable","ec2:DeleteRouteTable","ec2:AssociateRouteTable","ec2:DisassociateRouteTable","ec2:ReplaceRouteTableAssociation","ec2:CreateRoute","ec2:DeleteRoute","ec2:ReplaceRoute","ec2:CreateInternetGateway","ec2:DeleteInternetGateway","ec2:AttachInternetGateway","ec2:DetachInternetGateway","ec2:CreateEgressOnlyInternetGateway","ec2:DeleteEgressOnlyInternetGateway","ec2:CreateNatGateway","ec2:DeleteNatGateway","ec2:AllocateAddress","ec2:ReleaseAddress","ec2:AssociateAddress","ec2:DisassociateAddress","ec2:CreateSecurityGroup","ec2:DeleteSecurityGroup","ec2:AuthorizeSecurityGroupIngress","ec2:AuthorizeSecurityGroupEgress","ec2:RevokeSecurityGroupIngress","ec2:RevokeSecurityGroupEgress","ec2:ModifySecurityGroupRules","ec2:UpdateSecurityGroupRuleDescriptionsIngress","ec2:UpdateSecurityGroupRuleDescriptionsEgress","ec2:CreateNetworkAcl","ec2:DeleteNetworkAcl","ec2:CreateNetworkAclEntry","ec2:DeleteNetworkAclEntry","ec2:ReplaceNetworkAclEntry","ec2:ReplaceNetworkAclAssociation","ec2:CreateVpcEndpoint","ec2:DeleteVpcEndpoints","ec2:ModifyVpcEndpoint","ec2:CreateFlowLogs","ec2:DeleteFlowLogs","ec2:CreateDhcpOptions","ec2:DeleteDhcpOptions","ec2:AssociateDhcpOptions","ec2:CreateNetworkInterface","ec2:DeleteNetworkInterface","ec2:AttachNetworkInterface","ec2:DetachNetworkInterface","ec2:ModifyNetworkInterfaceAttribute","ec2:AssignPrivateIpAddresses","ec2:UnassignPrivateIpAddresses","ec2:CreateNetworkInterfacePermission","ec2:DeleteNetworkInterfacePermission","ec2:CreateVpcPeeringConnection","ec2:AcceptVpcPeeringConnection","ec2:DeleteVpcPeeringConnection","ec2:ModifyVpcPeeringConnectionOptions","ec2:CreateLaunchTemplate","ec2:CreateLaunchTemplateVersion","ec2:DeleteLaunchTemplate","ec2:DeleteLaunchTemplateVersions","ec2:ModifyLaunchTemplate","ec2:RunInstances","ec2:TerminateInstances","ec2:StartInstances","ec2:StopInstances","ec2:ModifyInstanceAttribute","ec2:ModifyInstanceMetadataOptions","ec2:ModifyInstanceCapacityReservationAttributes","ec2:MonitorInstances","ec2:CreateFleet","ec2:DeleteFleets","ec2:CreatePlacementGroup","ec2:DeletePlacementGroup","ec2:CreateVolume","ec2:DeleteVolume","ec2:AttachVolume","ec2:DetachVolume","ec2:ModifyVolume","ec2:CreateSnapshot","ec2:DeleteSnapshot","ec2:RequestSpotInstances","ec2:CancelSpotInstanceRequests","ec2:CreateSpotDatafeedSubscription","ec2:CreateCapacityReservation","ec2:CreateTags","ec2:DeleteTags","eks:Describe*","eks:List*","eks:CreateCluster","eks:DeleteCluster","eks:UpdateClusterConfig","eks:UpdateClusterVersion","eks:CreateNodegroup","eks:DeleteNodegroup","eks:UpdateNodegroupConfig","eks:UpdateNodegroupVersion","eks:CreateAddon","eks:DeleteAddon","eks:UpdateAddon","eks:CreateAccessEntry","eks:DeleteAccessEntry","eks:UpdateAccessEntry","eks:AssociateAccessPolicy","eks:DisassociateAccessPolicy","eks:CreatePodIdentityAssociation","eks:DeletePodIdentityAssociation","eks:UpdatePodIdentityAssociation","eks:CreateFargateProfile","eks:DeleteFargateProfile","eks:AssociateIdentityProviderConfig","eks:DisassociateIdentityProviderConfig","eks:RegisterCluster","eks:DeregisterCluster","eks:TagResource","eks:UntagResource"],
    "Resource": "*"
  }]
}
JSON
cat >"${TMPD}/compute_scale.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "ScalingLoadBalancingMetrics",
    "Effect": "Allow",
    "Action": ["autoscaling:Describe*","autoscaling:CreateAutoScalingGroup","autoscaling:UpdateAutoScalingGroup","autoscaling:DeleteAutoScalingGroup","autoscaling:CreateOrUpdateTags","autoscaling:DeleteTags","autoscaling:PutScheduledUpdateGroupAction","autoscaling:DeleteScheduledAction","autoscaling:PutScalingPolicy","autoscaling:DeletePolicy","autoscaling:PutLifecycleHook","autoscaling:DeleteLifecycleHook","autoscaling:PutNotificationConfiguration","autoscaling:DeleteNotificationConfiguration","autoscaling:AttachInstances","autoscaling:DetachInstances","autoscaling:SetDesiredCapacity","autoscaling:EnableMetricsCollection","autoscaling:DisableMetricsCollection","autoscaling:SuspendProcesses","autoscaling:ResumeProcesses","autoscaling:AttachLoadBalancers","autoscaling:DetachLoadBalancers","autoscaling:AttachLoadBalancerTargetGroups","autoscaling:DetachLoadBalancerTargetGroups","autoscaling:StartInstanceRefresh","application-autoscaling:Describe*","application-autoscaling:RegisterScalableTarget","application-autoscaling:DeregisterScalableTarget","application-autoscaling:PutScalingPolicy","application-autoscaling:DeleteScalingPolicy","application-autoscaling:PutScheduledAction","application-autoscaling:DeleteScheduledAction","application-autoscaling:TagResource","application-autoscaling:UntagResource","application-autoscaling:ListTagsForResource","elasticloadbalancing:Describe*","elasticloadbalancing:CreateLoadBalancer","elasticloadbalancing:DeleteLoadBalancer","elasticloadbalancing:ModifyLoadBalancerAttributes","elasticloadbalancing:SetSubnets","elasticloadbalancing:SetSecurityGroups","elasticloadbalancing:SetIpAddressType","elasticloadbalancing:CreateTargetGroup","elasticloadbalancing:DeleteTargetGroup","elasticloadbalancing:ModifyTargetGroup","elasticloadbalancing:ModifyTargetGroupAttributes","elasticloadbalancing:RegisterTargets","elasticloadbalancing:DeregisterTargets","elasticloadbalancing:CreateListener","elasticloadbalancing:DeleteListener","elasticloadbalancing:ModifyListener","elasticloadbalancing:CreateRule","elasticloadbalancing:DeleteRule","elasticloadbalancing:ModifyRule","elasticloadbalancing:SetRulePriorities","elasticloadbalancing:AddTags","elasticloadbalancing:RemoveTags","elasticloadbalancing:AddListenerCertificates","elasticloadbalancing:RemoveListenerCertificates","elasticloadbalancing:SetWebAcl","events:Describe*","events:List*","events:PutRule","events:DeleteRule","events:EnableRule","events:DisableRule","events:PutTargets","events:RemoveTargets","events:TagResource","events:UntagResource","cloudwatch:Describe*","cloudwatch:List*","cloudwatch:Get*","cloudwatch:PutMetricAlarm","cloudwatch:DeleteAlarms","cloudwatch:PutCompositeAlarm","cloudwatch:EnableAlarmActions","cloudwatch:DisableAlarmActions","cloudwatch:PutDashboard","cloudwatch:DeleteDashboards","cloudwatch:TagResource","cloudwatch:UntagResource","pricing:GetProducts","pricing:DescribeServices","pricing:GetAttributeValues","tag:GetResources","tag:GetTagKeys","tag:GetTagValues","tag:TagResources","tag:UntagResources","ram:GetResourceShares","ram:ListResources","ram:GetResourceShareAssociations","ram:ListResourceSharePermissions","ram:ListPrincipals","sts:GetCallerIdentity"],
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
    "Action": ["rds:Describe*","rds:List*","rds:CreateDBCluster","rds:DeleteDBCluster","rds:ModifyDBCluster","rds:StartDBCluster","rds:StopDBCluster","rds:CreateDBInstance","rds:DeleteDBInstance","rds:ModifyDBInstance","rds:CreateDBSubnetGroup","rds:DeleteDBSubnetGroup","rds:ModifyDBSubnetGroup","rds:CreateDBClusterParameterGroup","rds:DeleteDBClusterParameterGroup","rds:ModifyDBClusterParameterGroup","rds:ResetDBClusterParameterGroup","rds:CreateDBParameterGroup","rds:DeleteDBParameterGroup","rds:ModifyDBParameterGroup","rds:ResetDBParameterGroup","rds:AddRoleToDBCluster","rds:RemoveRoleFromDBCluster","rds:CreateDBClusterSnapshot","rds:DeleteDBClusterSnapshot","rds:RestoreDBClusterFromSnapshot","rds:ModifyDBClusterSnapshotAttribute","rds:CreateDBClusterEndpoint","rds:DeleteDBClusterEndpoint","rds:ModifyDBClusterEndpoint","rds:AddTagsToResource","rds:RemoveTagsFromResource","elasticache:Describe*","elasticache:List*","elasticache:CreateReplicationGroup","elasticache:DeleteReplicationGroup","elasticache:ModifyReplicationGroup","elasticache:ModifyReplicationGroupShardConfiguration","elasticache:CreateCacheCluster","elasticache:DeleteCacheCluster","elasticache:ModifyCacheCluster","elasticache:CreateServerlessCache","elasticache:DeleteServerlessCache","elasticache:ModifyServerlessCache","elasticache:CreateCacheSubnetGroup","elasticache:DeleteCacheSubnetGroup","elasticache:ModifyCacheSubnetGroup","elasticache:CreateCacheParameterGroup","elasticache:DeleteCacheParameterGroup","elasticache:ModifyCacheParameterGroup","elasticache:ResetCacheParameterGroup","elasticache:CreateUser","elasticache:DeleteUser","elasticache:ModifyUser","elasticache:CreateUserGroup","elasticache:DeleteUserGroup","elasticache:ModifyUserGroup","elasticache:CreateGlobalReplicationGroup","elasticache:DeleteGlobalReplicationGroup","elasticache:ModifyGlobalReplicationGroup","elasticache:CreateSnapshot","elasticache:DeleteSnapshot","elasticache:AddTagsToResource","elasticache:RemoveTagsFromResource","dynamodb:Describe*","dynamodb:List*","dynamodb:CreateTable","dynamodb:DeleteTable","dynamodb:UpdateTable","dynamodb:CreateGlobalTable","dynamodb:UpdateGlobalTable","dynamodb:UpdateGlobalTableSettings","dynamodb:UpdateTableReplicaAutoScaling","dynamodb:UpdateContinuousBackups","dynamodb:UpdateTimeToLive","dynamodb:PutResourcePolicy","dynamodb:DeleteResourcePolicy","dynamodb:GetResourcePolicy","dynamodb:TagResource","dynamodb:UntagResource","s3:Get*","s3:List*","s3:Put*","s3:CreateBucket","s3:DeleteBucket","s3:DeleteBucketPolicy","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion","ecr:Describe*","ecr:Get*","ecr:List*","ecr:BatchGetImage","ecr:BatchGetRepositoryScanningConfiguration","ecr:CreateRepository","ecr:DeleteRepository","ecr:PutLifecyclePolicy","ecr:DeleteLifecyclePolicy","ecr:SetRepositoryPolicy","ecr:DeleteRepositoryPolicy","ecr:PutImageScanningConfiguration","ecr:PutImageTagMutability","ecr:PutRegistryScanningConfiguration","ecr:PutRegistryPolicy","ecr:DeleteRegistryPolicy","ecr:PutReplicationConfiguration","ecr:CreatePullThroughCacheRule","ecr:DeletePullThroughCacheRule","ecr:CreateRepositoryCreationTemplate","ecr:DeleteRepositoryCreationTemplate","ecr:UpdateRepositoryCreationTemplate","ecr:TagResource","ecr:UntagResource","ecr:GetAuthorizationToken","secretsmanager:Describe*","secretsmanager:List*","secretsmanager:GetSecretValue","secretsmanager:GetResourcePolicy","secretsmanager:GetRandomPassword","secretsmanager:CreateSecret","secretsmanager:DeleteSecret","secretsmanager:UpdateSecret","secretsmanager:PutSecretValue","secretsmanager:RestoreSecret","secretsmanager:RotateSecret","secretsmanager:CancelRotateSecret","secretsmanager:PutResourcePolicy","secretsmanager:DeleteResourcePolicy","secretsmanager:TagResource","secretsmanager:UntagResource","kms:Describe*","kms:Get*","kms:List*","kms:CreateKey","kms:ScheduleKeyDeletion","kms:CancelKeyDeletion","kms:EnableKey","kms:DisableKey","kms:PutKeyPolicy","kms:CreateAlias","kms:DeleteAlias","kms:UpdateAlias","kms:CreateGrant","kms:RetireGrant","kms:RevokeGrant","kms:EnableKeyRotation","kms:DisableKeyRotation","kms:ReplicateKey","kms:UpdatePrimaryRegion","kms:TagResource","kms:UntagResource","kms:Encrypt","kms:Decrypt","kms:GenerateDataKey","kms:GenerateDataKeyWithoutPlaintext","kms:ReEncryptFrom","kms:ReEncryptTo","sqs:Get*","sqs:List*","sqs:CreateQueue","sqs:DeleteQueue","sqs:SetQueueAttributes","sqs:TagQueue","sqs:UntagQueue","sqs:AddPermission","sqs:RemovePermission","sns:Get*","sns:List*","sns:CreateTopic","sns:DeleteTopic","sns:SetTopicAttributes","sns:Subscribe","sns:Unsubscribe","sns:ConfirmSubscription","sns:SetSubscriptionAttributes","sns:TagResource","sns:UntagResource","sns:AddPermission","sns:RemovePermission","ssm:Get*","ssm:Describe*","ssm:List*","ssm:PutParameter","ssm:DeleteParameter","ssm:DeleteParameters","ssm:LabelParameterVersion","ssm:CreateActivation","ssm:DeleteActivation","ssm:AddTagsToResource","ssm:RemoveTagsFromResource"],
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
    "Action": ["route53:Get*","route53:List*","route53:CreateHostedZone","route53:DeleteHostedZone","route53:UpdateHostedZoneComment","route53:ChangeResourceRecordSets","route53:ChangeTagsForResource","route53:AssociateVPCWithHostedZone","route53:DisassociateVPCFromHostedZone","route53:CreateQueryLoggingConfig","route53:DeleteQueryLoggingConfig","route53domains:ListDomains","acm:Describe*","acm:List*","acm:Get*","acm:RequestCertificate","acm:DeleteCertificate","acm:AddTagsToCertificate","acm:RemoveTagsFromCertificate","wafv2:Get*","wafv2:List*","wafv2:Describe*","wafv2:CheckCapacity","wafv2:CreateWebACL","wafv2:DeleteWebACL","wafv2:UpdateWebACL","wafv2:PutLoggingConfiguration","wafv2:DeleteLoggingConfiguration","wafv2:AssociateWebACL","wafv2:DisassociateWebACL","wafv2:TagResource","wafv2:UntagResource","logs:Describe*","logs:List*","logs:Get*","logs:CreateLogGroup","logs:DeleteLogGroup","logs:CreateLogStream","logs:DeleteLogStream","logs:PutRetentionPolicy","logs:DeleteRetentionPolicy","logs:PutResourcePolicy","logs:DeleteResourcePolicy","logs:AssociateKmsKey","logs:DisassociateKmsKey","logs:TagResource","logs:UntagResource","logs:TagLogGroup","logs:UntagLogGroup","logs:PutLogEvents","firehose:CreateDeliveryStream","firehose:DeleteDeliveryStream","firehose:UpdateDestination","firehose:DescribeDeliveryStream","firehose:ListDeliveryStreams","firehose:ListTagsForDeliveryStream","firehose:TagDeliveryStream","firehose:UntagDeliveryStream","firehose:StartDeliveryStreamEncryption","firehose:StopDeliveryStreamEncryption","cloudfront:Get*","cloudfront:List*","cloudfront:UpdateDistribution","cloudfront:TagResource","cloudfront:UntagResource","ecr-public:DescribeRegistries","ecr-public:DescribeRepositories","ecr-public:GetRepositoryPolicy","ecr-public:ListTagsForResource","ecr-public:CreateRepository","ecr-public:DeleteRepository","ecr-public:SetRepositoryPolicy","ecr-public:DeleteRepositoryPolicy","ecr-public:TagResource","ecr-public:UntagResource","ecr-public:GetAuthorizationToken","sts:GetServiceBearerToken"],
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
      "Action": ["iam:CreateRole","iam:DeleteRole","iam:GetRole","iam:UpdateRole","iam:TagRole","iam:UntagRole","iam:UpdateAssumeRolePolicy","iam:PutRolePolicy","iam:DeleteRolePolicy","iam:GetRolePolicy","iam:AttachRolePolicy","iam:DetachRolePolicy","iam:ListRolePolicies","iam:ListAttachedRolePolicies","iam:ListRoleTags","iam:CreatePolicy","iam:DeletePolicy","iam:GetPolicy","iam:CreatePolicyVersion","iam:DeletePolicyVersion","iam:GetPolicyVersion","iam:ListPolicyVersions","iam:ListPolicies","iam:CreateInstanceProfile","iam:DeleteInstanceProfile","iam:GetInstanceProfile","iam:AddRoleToInstanceProfile","iam:RemoveRoleFromInstanceProfile","iam:TagInstanceProfile","iam:CreateOpenIDConnectProvider","iam:DeleteOpenIDConnectProvider","iam:GetOpenIDConnectProvider","iam:TagOpenIDConnectProvider","iam:UpdateOpenIDConnectProviderThumbprint","iam:AddClientIDToOpenIDConnectProvider","iam:CreateUser","iam:DeleteUser","iam:GetUser","iam:TagUser","iam:PutUserPolicy","iam:DeleteUserPolicy","iam:GetUserPolicy","iam:ListUserPolicies","iam:AttachUserPolicy","iam:DetachUserPolicy","iam:CreateAccessKey","iam:DeleteAccessKey","iam:ListAccessKeys","iam:ListInstanceProfilesForRole","iam:ListInstanceProfiles","iam:ListInstanceProfileTags","iam:ListOpenIDConnectProviders","iam:ListRoles"],
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
      "Condition": { "StringEquals": { "iam:AWSServiceName": ["eks.amazonaws.com","eks-nodegroup.amazonaws.com","spot.amazonaws.com","elasticache.amazonaws.com","rds.amazonaws.com","elasticloadbalancing.amazonaws.com","autoscaling.amazonaws.com"] } }
    },
    {
      "Sid": "DenyAttachAdminGradePolicies",
      "Effect": "Deny",
      "Action": ["iam:AttachRolePolicy","iam:AttachUserPolicy","iam:PutRolePolicy","iam:PutUserPolicy"],
      "Resource": "*",
      "Condition": { "ArnEquals": { "iam:PolicyARN": ["arn:aws:iam::aws:policy/AdministratorAccess","arn:aws:iam::aws:policy/IAMFullAccess","arn:aws:iam::aws:policy/PowerUserAccess"] } }
    },
    {
      "Sid": "DenyOrgAccountAndBilling",
      "Effect": "Deny",
      "Action": ["organizations:*","account:*","iam:CreateAccountAlias","iam:DeleteAccountAlias","aws-portal:*","billing:*","payments:*","budgets:*","ce:*","cur:*","purchase-orders:*"],
      "Resource": "*"
    }
  ]
}
JSON

echo ""
echo "==> Creating + attaching the least-privilege policies..."
for scope in compute_net compute_scale data edge iam; do
  case "${scope}" in
    compute_net) suffix="ComputeNet" ;;
    compute_scale) suffix="ComputeScale" ;;
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
