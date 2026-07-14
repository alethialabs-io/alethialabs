variable "issuer_url" {
  type        = string
  default     = "https://alethialabs.io/api/oidc"
  description = "The Alethia control-plane OIDC issuer this account trusts. Override only for a self-hosted Alethia."
}

variable "issuer_audience" {
  type        = string
  default     = "sts.amazonaws.com"
  description = "The audience the minted assertion carries (pinned in the trust policy). Do not change."
}

variable "workload_subject" {
  type        = string
  default     = "alethia-connector"
  description = "The fixed workload subject Alethia mints (pinned in the trust policy). Do not change."
}

variable "role_name" {
  type        = string
  default     = "AlethiaProvisionerRole"
  description = "The name of the IAM role to be created."
}

locals {
  # The OIDC condition keys AWS derives from the provider URL (scheme stripped).
  oidc_host = replace(var.issuer_url, "https://", "")
}

# The Alethia issuer as an IAM OIDC identity provider. AWS validates each assertion's signature against the
# issuer's published JWKS; the thumbprint is required by the API but no longer used for a well-known-CA
# issuer, so we derive it from the live TLS chain rather than hand-maintaining it.
data "tls_certificate" "issuer" {
  url = var.issuer_url
}

resource "aws_iam_openid_connect_provider" "alethia" {
  url             = var.issuer_url
  client_id_list  = [var.issuer_audience]
  thumbprint_list = [data.tls_certificate.issuer.certificates[length(data.tls_certificate.issuer.certificates) - 1].sha1_fingerprint]
}

# Trust ONLY Alethia's issuer, pinned to the fixed workload subject + audience the console mints — no
# external id, no trust in an Alethia AWS account. A wrong sub/aud is rejected.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.alethia.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = [var.issuer_audience]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = [var.workload_subject]
    }
  }
}

resource "aws_iam_role" "alethia_role" {
  name               = var.role_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_caller_identity" "current" {}

# ─────────────────────────────────────────────────────────────────────────────
# Least-privilege provisioning policy (replaces AdministratorAccess).
#
# Scoped to EXACTLY the services + ACTIONS Alethia's project templates create — no more.
# Fully ACTION-ENUMERATED (no `service:*`): the data-plane buckets list the specific create/
# read/modify/delete/tag actions the module estate issues (derived from the template resource
# set + the community-module IAM docs), and the IAM block is enumerated + PassRole-by-service +
# denies attaching admin-grade managed policies. Reads stay `Describe*/Get*/List*` and lean
# slightly permissive within a service so a module bump doesn't break a real apply. The compute
# bucket is split (net/scale) to stay under the 6144-char managed-policy limit; a fresh Project
# uses a subset of these services, gated by feature toggles.
#
# What is NOT here (and thus denied): organizations:*, account:*, billing/cost, and any service
# Alethia does not provision. NB: this connector role is MULTI-REGION by design (a customer's
# projects can span regions), so — unlike the single-region e2e-nightly boundary — there is
# deliberately NO region lock here.
# ─────────────────────────────────────────────────────────────────────────────

# Compute: VPC + EKS cluster networking — ENUMERATED (no service:* wildcards). Derived from the module
# estate (terraform-aws-modules/{vpc,eks}, Karpenter, the AWS LB controller). Split from the scaling
# bucket because the enumerated set exceeds the 6144-char managed-policy limit as a single policy.
data "aws_iam_policy_document" "compute_net" {
  statement {
    sid    = "ComputeClusterNetworking"
    effect = "Allow"
    actions = [
      "ec2:Describe*",
      "ec2:Get*",
      "ec2:CreateVpc",
      "ec2:DeleteVpc",
      "ec2:ModifyVpcAttribute",
      "ec2:AssociateVpcCidrBlock",
      "ec2:DisassociateVpcCidrBlock",
      "ec2:CreateSubnet",
      "ec2:DeleteSubnet",
      "ec2:ModifySubnetAttribute",
      "ec2:CreateRouteTable",
      "ec2:DeleteRouteTable",
      "ec2:AssociateRouteTable",
      "ec2:DisassociateRouteTable",
      "ec2:ReplaceRouteTableAssociation",
      "ec2:CreateRoute",
      "ec2:DeleteRoute",
      "ec2:ReplaceRoute",
      "ec2:CreateInternetGateway",
      "ec2:DeleteInternetGateway",
      "ec2:AttachInternetGateway",
      "ec2:DetachInternetGateway",
      "ec2:CreateEgressOnlyInternetGateway",
      "ec2:DeleteEgressOnlyInternetGateway",
      "ec2:CreateNatGateway",
      "ec2:DeleteNatGateway",
      "ec2:AllocateAddress",
      "ec2:ReleaseAddress",
      "ec2:AssociateAddress",
      "ec2:DisassociateAddress",
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:ModifySecurityGroupRules",
      "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
      "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
      "ec2:CreateNetworkAcl",
      "ec2:DeleteNetworkAcl",
      "ec2:CreateNetworkAclEntry",
      "ec2:DeleteNetworkAclEntry",
      "ec2:ReplaceNetworkAclEntry",
      "ec2:ReplaceNetworkAclAssociation",
      "ec2:CreateVpcEndpoint",
      "ec2:DeleteVpcEndpoints",
      "ec2:ModifyVpcEndpoint",
      "ec2:CreateFlowLogs",
      "ec2:DeleteFlowLogs",
      "ec2:CreateDhcpOptions",
      "ec2:DeleteDhcpOptions",
      "ec2:AssociateDhcpOptions",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:AttachNetworkInterface",
      "ec2:DetachNetworkInterface",
      "ec2:ModifyNetworkInterfaceAttribute",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
      "ec2:CreateNetworkInterfacePermission",
      "ec2:DeleteNetworkInterfacePermission",
      "ec2:CreateVpcPeeringConnection",
      "ec2:AcceptVpcPeeringConnection",
      "ec2:DeleteVpcPeeringConnection",
      "ec2:ModifyVpcPeeringConnectionOptions",
      "ec2:CreateLaunchTemplate",
      "ec2:CreateLaunchTemplateVersion",
      "ec2:DeleteLaunchTemplate",
      "ec2:DeleteLaunchTemplateVersions",
      "ec2:ModifyLaunchTemplate",
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifyInstanceMetadataOptions",
      "ec2:ModifyInstanceCapacityReservationAttributes",
      "ec2:MonitorInstances",
      "ec2:CreateFleet",
      "ec2:DeleteFleets",
      "ec2:CreatePlacementGroup",
      "ec2:DeletePlacementGroup",
      "ec2:CreateVolume",
      "ec2:DeleteVolume",
      "ec2:AttachVolume",
      "ec2:DetachVolume",
      "ec2:ModifyVolume",
      "ec2:CreateSnapshot",
      "ec2:DeleteSnapshot",
      "ec2:RequestSpotInstances",
      "ec2:CancelSpotInstanceRequests",
      "ec2:CreateSpotDatafeedSubscription",
      "ec2:CreateCapacityReservation",
      "ec2:CreateTags",
      "ec2:DeleteTags",
      "eks:Describe*",
      "eks:List*",
      "eks:CreateCluster",
      "eks:DeleteCluster",
      "eks:UpdateClusterConfig",
      "eks:UpdateClusterVersion",
      "eks:CreateNodegroup",
      "eks:DeleteNodegroup",
      "eks:UpdateNodegroupConfig",
      "eks:UpdateNodegroupVersion",
      "eks:CreateAddon",
      "eks:DeleteAddon",
      "eks:UpdateAddon",
      "eks:CreateAccessEntry",
      "eks:DeleteAccessEntry",
      "eks:UpdateAccessEntry",
      "eks:AssociateAccessPolicy",
      "eks:DisassociateAccessPolicy",
      "eks:CreatePodIdentityAssociation",
      "eks:DeletePodIdentityAssociation",
      "eks:UpdatePodIdentityAssociation",
      "eks:CreateFargateProfile",
      "eks:DeleteFargateProfile",
      "eks:AssociateIdentityProviderConfig",
      "eks:DisassociateIdentityProviderConfig",
      "eks:RegisterCluster",
      "eks:DeregisterCluster",
      "eks:TagResource",
      "eks:UntagResource",
    ]
    resources = ["*"]
  }
}

# Scaling + load balancing + events + metrics + tagging + RAM — ENUMERATED (the compute split half).
data "aws_iam_policy_document" "compute_scale" {
  statement {
    sid    = "ScalingLoadBalancingMetrics"
    effect = "Allow"
    actions = [
      "autoscaling:Describe*",
      "autoscaling:CreateAutoScalingGroup",
      "autoscaling:UpdateAutoScalingGroup",
      "autoscaling:DeleteAutoScalingGroup",
      "autoscaling:CreateOrUpdateTags",
      "autoscaling:DeleteTags",
      "autoscaling:PutScheduledUpdateGroupAction",
      "autoscaling:DeleteScheduledAction",
      "autoscaling:PutScalingPolicy",
      "autoscaling:DeletePolicy",
      "autoscaling:PutLifecycleHook",
      "autoscaling:DeleteLifecycleHook",
      "autoscaling:PutNotificationConfiguration",
      "autoscaling:DeleteNotificationConfiguration",
      "autoscaling:AttachInstances",
      "autoscaling:DetachInstances",
      "autoscaling:SetDesiredCapacity",
      "autoscaling:EnableMetricsCollection",
      "autoscaling:DisableMetricsCollection",
      "autoscaling:SuspendProcesses",
      "autoscaling:ResumeProcesses",
      "autoscaling:AttachLoadBalancers",
      "autoscaling:DetachLoadBalancers",
      "autoscaling:AttachLoadBalancerTargetGroups",
      "autoscaling:DetachLoadBalancerTargetGroups",
      "autoscaling:StartInstanceRefresh",
      "application-autoscaling:Describe*",
      "application-autoscaling:RegisterScalableTarget",
      "application-autoscaling:DeregisterScalableTarget",
      "application-autoscaling:PutScalingPolicy",
      "application-autoscaling:DeleteScalingPolicy",
      "application-autoscaling:PutScheduledAction",
      "application-autoscaling:DeleteScheduledAction",
      "application-autoscaling:TagResource",
      "application-autoscaling:UntagResource",
      "application-autoscaling:ListTagsForResource",
      "elasticloadbalancing:Describe*",
      "elasticloadbalancing:CreateLoadBalancer",
      "elasticloadbalancing:DeleteLoadBalancer",
      "elasticloadbalancing:ModifyLoadBalancerAttributes",
      "elasticloadbalancing:SetSubnets",
      "elasticloadbalancing:SetSecurityGroups",
      "elasticloadbalancing:SetIpAddressType",
      "elasticloadbalancing:CreateTargetGroup",
      "elasticloadbalancing:DeleteTargetGroup",
      "elasticloadbalancing:ModifyTargetGroup",
      "elasticloadbalancing:ModifyTargetGroupAttributes",
      "elasticloadbalancing:RegisterTargets",
      "elasticloadbalancing:DeregisterTargets",
      "elasticloadbalancing:CreateListener",
      "elasticloadbalancing:DeleteListener",
      "elasticloadbalancing:ModifyListener",
      "elasticloadbalancing:CreateRule",
      "elasticloadbalancing:DeleteRule",
      "elasticloadbalancing:ModifyRule",
      "elasticloadbalancing:SetRulePriorities",
      "elasticloadbalancing:AddTags",
      "elasticloadbalancing:RemoveTags",
      "elasticloadbalancing:AddListenerCertificates",
      "elasticloadbalancing:RemoveListenerCertificates",
      "elasticloadbalancing:SetWebAcl",
      "events:Describe*",
      "events:List*",
      "events:PutRule",
      "events:DeleteRule",
      "events:EnableRule",
      "events:DisableRule",
      "events:PutTargets",
      "events:RemoveTargets",
      "events:TagResource",
      "events:UntagResource",
      "cloudwatch:Describe*",
      "cloudwatch:List*",
      "cloudwatch:Get*",
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DeleteAlarms",
      "cloudwatch:PutCompositeAlarm",
      "cloudwatch:EnableAlarmActions",
      "cloudwatch:DisableAlarmActions",
      "cloudwatch:PutDashboard",
      "cloudwatch:DeleteDashboards",
      "cloudwatch:TagResource",
      "cloudwatch:UntagResource",
      "pricing:GetProducts",
      "pricing:DescribeServices",
      "pricing:GetAttributeValues",
      "tag:GetResources",
      "tag:GetTagKeys",
      "tag:GetTagValues",
      "tag:TagResources",
      "tag:UntagResources",
      "ram:GetResourceShares",
      "ram:ListResources",
      "ram:GetResourceShareAssociations",
      "ram:ListResourceSharePermissions",
      "ram:ListPrincipals",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }
}

# Data stores + secrets + encryption + messaging + registry + object storage — ENUMERATED.
data "aws_iam_policy_document" "data" {
  statement {
    sid    = "DataSecretsMessagingRegistry"
    effect = "Allow"
    actions = [
      "rds:Describe*", "rds:List*",
      "rds:CreateDBCluster", "rds:DeleteDBCluster", "rds:ModifyDBCluster", "rds:StartDBCluster", "rds:StopDBCluster",
      "rds:CreateDBInstance", "rds:DeleteDBInstance", "rds:ModifyDBInstance",
      "rds:CreateDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:ModifyDBSubnetGroup",
      "rds:CreateDBClusterParameterGroup", "rds:DeleteDBClusterParameterGroup", "rds:ModifyDBClusterParameterGroup", "rds:ResetDBClusterParameterGroup",
      "rds:CreateDBParameterGroup", "rds:DeleteDBParameterGroup", "rds:ModifyDBParameterGroup", "rds:ResetDBParameterGroup",
      "rds:AddRoleToDBCluster", "rds:RemoveRoleFromDBCluster",
      "rds:CreateDBClusterSnapshot", "rds:DeleteDBClusterSnapshot", "rds:RestoreDBClusterFromSnapshot", "rds:ModifyDBClusterSnapshotAttribute",
      "rds:CreateDBClusterEndpoint", "rds:DeleteDBClusterEndpoint", "rds:ModifyDBClusterEndpoint",
      "rds:AddTagsToResource", "rds:RemoveTagsFromResource",
      "elasticache:Describe*", "elasticache:List*",
      "elasticache:CreateReplicationGroup", "elasticache:DeleteReplicationGroup", "elasticache:ModifyReplicationGroup", "elasticache:ModifyReplicationGroupShardConfiguration",
      "elasticache:CreateCacheCluster", "elasticache:DeleteCacheCluster", "elasticache:ModifyCacheCluster",
      "elasticache:CreateServerlessCache", "elasticache:DeleteServerlessCache", "elasticache:ModifyServerlessCache",
      "elasticache:CreateCacheSubnetGroup", "elasticache:DeleteCacheSubnetGroup", "elasticache:ModifyCacheSubnetGroup",
      "elasticache:CreateCacheParameterGroup", "elasticache:DeleteCacheParameterGroup", "elasticache:ModifyCacheParameterGroup", "elasticache:ResetCacheParameterGroup",
      "elasticache:CreateUser", "elasticache:DeleteUser", "elasticache:ModifyUser",
      "elasticache:CreateUserGroup", "elasticache:DeleteUserGroup", "elasticache:ModifyUserGroup",
      "elasticache:CreateGlobalReplicationGroup", "elasticache:DeleteGlobalReplicationGroup", "elasticache:ModifyGlobalReplicationGroup",
      "elasticache:CreateSnapshot", "elasticache:DeleteSnapshot",
      "elasticache:AddTagsToResource", "elasticache:RemoveTagsFromResource",
      "dynamodb:Describe*", "dynamodb:List*",
      "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:UpdateTable",
      "dynamodb:CreateGlobalTable", "dynamodb:UpdateGlobalTable", "dynamodb:UpdateGlobalTableSettings",
      "dynamodb:UpdateTableReplicaAutoScaling", "dynamodb:UpdateContinuousBackups",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:PutResourcePolicy", "dynamodb:DeleteResourcePolicy", "dynamodb:GetResourcePolicy",
      "dynamodb:TagResource", "dynamodb:UntagResource",
      "s3:Get*", "s3:List*", "s3:Put*",
      "s3:CreateBucket", "s3:DeleteBucket", "s3:DeleteBucketPolicy",
      "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
      "ecr:Describe*", "ecr:Get*", "ecr:List*", "ecr:BatchGetImage", "ecr:BatchGetRepositoryScanningConfiguration",
      "ecr:CreateRepository", "ecr:DeleteRepository",
      "ecr:PutLifecyclePolicy", "ecr:DeleteLifecyclePolicy",
      "ecr:SetRepositoryPolicy", "ecr:DeleteRepositoryPolicy",
      "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability",
      "ecr:PutRegistryScanningConfiguration", "ecr:PutRegistryPolicy", "ecr:DeleteRegistryPolicy",
      "ecr:PutReplicationConfiguration",
      "ecr:CreatePullThroughCacheRule", "ecr:DeletePullThroughCacheRule",
      "ecr:CreateRepositoryCreationTemplate", "ecr:DeleteRepositoryCreationTemplate", "ecr:UpdateRepositoryCreationTemplate",
      "ecr:TagResource", "ecr:UntagResource",
      "ecr:GetAuthorizationToken",
      "secretsmanager:Describe*", "secretsmanager:List*", "secretsmanager:GetSecretValue", "secretsmanager:GetResourcePolicy", "secretsmanager:GetRandomPassword",
      "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue", "secretsmanager:RestoreSecret",
      "secretsmanager:RotateSecret", "secretsmanager:CancelRotateSecret",
      "secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy",
      "secretsmanager:TagResource", "secretsmanager:UntagResource",
      "kms:Describe*", "kms:Get*", "kms:List*",
      "kms:CreateKey", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:EnableKey", "kms:DisableKey",
      "kms:PutKeyPolicy",
      "kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias",
      "kms:CreateGrant", "kms:RetireGrant", "kms:RevokeGrant",
      "kms:EnableKeyRotation", "kms:DisableKeyRotation",
      "kms:ReplicateKey", "kms:UpdatePrimaryRegion",
      "kms:TagResource", "kms:UntagResource",
      "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncryptFrom", "kms:ReEncryptTo",
      "sqs:Get*", "sqs:List*",
      "sqs:CreateQueue", "sqs:DeleteQueue", "sqs:SetQueueAttributes",
      "sqs:TagQueue", "sqs:UntagQueue", "sqs:AddPermission", "sqs:RemovePermission",
      "sns:Get*", "sns:List*",
      "sns:CreateTopic", "sns:DeleteTopic", "sns:SetTopicAttributes",
      "sns:Subscribe", "sns:Unsubscribe", "sns:ConfirmSubscription", "sns:SetSubscriptionAttributes",
      "sns:TagResource", "sns:UntagResource", "sns:AddPermission", "sns:RemovePermission",
      "ssm:Get*", "ssm:Describe*", "ssm:List*",
      "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion",
      "ssm:CreateActivation", "ssm:DeleteActivation",
      "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource",
    ]
    resources = ["*"]
  }
}

# Edge: DNS, certs, WAF, logs + log-delivery, CloudFront-WAF assoc, ECR-Public — ENUMERATED.
data "aws_iam_policy_document" "edge" {
  statement {
    sid    = "DnsCertsWafLogs"
    effect = "Allow"
    actions = [
      "route53:Get*", "route53:List*",
      "route53:CreateHostedZone", "route53:DeleteHostedZone", "route53:UpdateHostedZoneComment",
      "route53:ChangeResourceRecordSets",
      "route53:ChangeTagsForResource",
      "route53:AssociateVPCWithHostedZone", "route53:DisassociateVPCFromHostedZone",
      "route53:CreateQueryLoggingConfig", "route53:DeleteQueryLoggingConfig",
      "route53domains:ListDomains",
      "acm:Describe*", "acm:List*", "acm:Get*",
      "acm:RequestCertificate", "acm:DeleteCertificate",
      "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate",
      "wafv2:Get*", "wafv2:List*", "wafv2:Describe*", "wafv2:CheckCapacity",
      "wafv2:CreateWebACL", "wafv2:DeleteWebACL", "wafv2:UpdateWebACL",
      "wafv2:PutLoggingConfiguration", "wafv2:DeleteLoggingConfiguration",
      "wafv2:AssociateWebACL", "wafv2:DisassociateWebACL",
      "wafv2:TagResource", "wafv2:UntagResource",
      "logs:Describe*", "logs:List*", "logs:Get*",
      "logs:CreateLogGroup", "logs:DeleteLogGroup",
      "logs:CreateLogStream", "logs:DeleteLogStream",
      "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
      "logs:PutResourcePolicy", "logs:DeleteResourcePolicy",
      "logs:AssociateKmsKey", "logs:DisassociateKmsKey",
      "logs:TagResource", "logs:UntagResource", "logs:TagLogGroup", "logs:UntagLogGroup", "logs:PutLogEvents",
      "firehose:CreateDeliveryStream", "firehose:DeleteDeliveryStream", "firehose:UpdateDestination",
      "firehose:DescribeDeliveryStream", "firehose:ListDeliveryStreams", "firehose:ListTagsForDeliveryStream",
      "firehose:TagDeliveryStream", "firehose:UntagDeliveryStream",
      "firehose:StartDeliveryStreamEncryption", "firehose:StopDeliveryStreamEncryption",
      "cloudfront:Get*", "cloudfront:List*",
      "cloudfront:UpdateDistribution", "cloudfront:TagResource", "cloudfront:UntagResource",
      "ecr-public:DescribeRegistries", "ecr-public:DescribeRepositories", "ecr-public:GetRepositoryPolicy", "ecr-public:ListTagsForResource",
      "ecr-public:CreateRepository", "ecr-public:DeleteRepository",
      "ecr-public:SetRepositoryPolicy", "ecr-public:DeleteRepositoryPolicy",
      "ecr-public:TagResource", "ecr-public:UntagResource", "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]
    resources = ["*"]
  }
}

# IAM — action-enumerated (the escalation-sensitive surface). Lets the templates
# create the EKS cluster/node roles, IRSA roles, the OIDC provider, instance
# profiles, and (legacy) service users — but PassRole is restricted to the cloud
# services that consume these roles, and attaching Administrator/PowerUser/
# IAMFullAccess to any created principal is explicitly DENIED (closes the
# create-role-then-grant-admin escalation).
data "aws_iam_policy_document" "iam" {
  statement {
    sid    = "IamManageProvisionedPrincipals"
    effect = "Allow"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole",
      "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListRoleTags",
      "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy",
      "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
      "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicies",
      "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile",
      "iam:GetInstanceProfile", "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile",
      "iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider", "iam:TagOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:CreateUser", "iam:DeleteUser", "iam:GetUser", "iam:TagUser",
      "iam:PutUserPolicy", "iam:DeleteUserPolicy", "iam:GetUserPolicy",
      "iam:ListUserPolicies", "iam:AttachUserPolicy", "iam:DetachUserPolicy",
      "iam:CreateAccessKey", "iam:DeleteAccessKey", "iam:ListAccessKeys",
      "iam:ListInstanceProfilesForRole", "iam:ListInstanceProfiles", "iam:ListInstanceProfileTags",
      "iam:ListOpenIDConnectProviders", "iam:ListRoles",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "PassRoleToProvisionedServices"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "eks.amazonaws.com", "ec2.amazonaws.com", "rds.amazonaws.com",
        "monitoring.rds.amazonaws.com", "elasticache.amazonaws.com",
        "firehose.amazonaws.com", "application-autoscaling.amazonaws.com",
      ]
    }
  }
  statement {
    sid       = "CreateServiceLinkedRolesForProvisionedServices"
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "eks.amazonaws.com", "eks-nodegroup.amazonaws.com",
        "spot.amazonaws.com", "elasticache.amazonaws.com",
        "rds.amazonaws.com", "elasticloadbalancing.amazonaws.com",
        "autoscaling.amazonaws.com",
      ]
    }
  }
  # The keystone: never let the connector attach admin-grade managed policies to
  # anything it creates (or to itself). This closes the CreateRole → AttachAdmin
  # → assume path even though iam:CreateRole is granted above.
  statement {
    sid    = "DenyAttachAdminGradePolicies"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy", "iam:AttachUserPolicy",
      "iam:PutRolePolicy", "iam:PutUserPolicy",
    ]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:aws:iam::aws:policy/AdministratorAccess",
        "arn:aws:iam::aws:policy/IAMFullAccess",
        "arn:aws:iam::aws:policy/PowerUserAccess",
      ]
    }
  }
  # Belt-and-suspenders: no path back to account-wide privilege, and no billing/cost reach (the
  # provisioning estate never needs it — these are default-denied by omission from the Allow policies
  # anyway, but denied explicitly so a future policy widening can't accidentally re-grant them).
  statement {
    sid    = "DenyOrgAccountAndBilling"
    effect = "Deny"
    actions = [
      "organizations:*", "account:*", "iam:CreateAccountAlias", "iam:DeleteAccountAlias",
      "aws-portal:*", "billing:*", "payments:*", "budgets:*", "ce:*", "cur:*", "purchase-orders:*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "compute_net" {
  name   = "${var.role_name}-ComputeNet"
  policy = data.aws_iam_policy_document.compute_net.json
}

resource "aws_iam_policy" "compute_scale" {
  name   = "${var.role_name}-ComputeScale"
  policy = data.aws_iam_policy_document.compute_scale.json
}

resource "aws_iam_policy" "data" {
  name   = "${var.role_name}-Data"
  policy = data.aws_iam_policy_document.data.json
}

resource "aws_iam_policy" "edge" {
  name   = "${var.role_name}-Edge"
  policy = data.aws_iam_policy_document.edge.json
}

resource "aws_iam_policy" "iam" {
  name   = "${var.role_name}-IAM"
  policy = data.aws_iam_policy_document.iam.json
}

resource "aws_iam_role_policy_attachment" "scoped" {
  for_each = {
    compute_net   = aws_iam_policy.compute_net.arn
    compute_scale = aws_iam_policy.compute_scale.arn
    data          = aws_iam_policy.data.arn
    edge          = aws_iam_policy.edge.arn
    iam           = aws_iam_policy.iam.arn
  }
  role       = aws_iam_role.alethia_role.name
  policy_arn = each.value
}

output "role_arn" {
  value       = aws_iam_role.alethia_role.arn
  description = "The ARN of the created role. Copy this back into the Alethia dashboard."
}
