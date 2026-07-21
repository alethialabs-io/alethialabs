# NOTE (#957): the roles below are CLUSTER-level IRSA, provisioned by tofu at Fabric creation and scoped
# to specific control-plane KSAs (e.g. default:alethia-app). A `namespace`-placement tenant does NOT get
# one of these — its per-namespace tenant identity is provisioned by the RUNNER via the IAM SDK at
# deploy time (packages/core/cloud/aws/tenant_identity.go: a zero-perm role trusting
# system:serviceaccount:<ns>:*), because the namespace-deploy path runs no tofu. GCP Workload-Identity /
# Azure federated per-namespace parity is the documented #1013 follow-up.

##########################
#IRSA for RDS IAM Auth   #
##########################
# The keyless app workload's identity (#722). Least-privilege on both axes:
#   - scoped to the EXACT app KSA (default/alethia-app), not "*:*" — only that pod can assume it, so a
#     stray workload can't mint DB tokens (parity with the GCP/Azure per-KSA subject binding);
#   - rds-db:connect ONLY, and only as the `alethia_app` user (the bootstrap-created least-priv role),
#     not the former rds-db:* on dbuser:*/*. The unrelated SQS-FullAccess / KMS-PowerUser grants that
#     used to ride on this role are dropped — a keyless DB identity has no business holding them.
module "rds_iam_auth" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  count   = var.rds_iam_irsa ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "rds-iam-auth-${local.eks_name}"
  role_policy_arns = {
    rds_iam_auth_policy = aws_iam_policy.rds_iam_auth.arn
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks[0].oidc_provider_arn
      namespace_service_accounts = ["default:alethia-app"]
    }
  }
}



resource "aws_iam_policy" "rds_iam_auth" {

  name_prefix = "rds_iam_auth"
  description = "Policy for the keyless app ServiceAccount allowing RDS IAM connect as alethia_app for cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "rds-db:connect"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:rds-db:${var.region}:${var.aws_account_id}:dbuser:*/alethia_app",
            "Sid": "AllowRDSiamAccess"
        }
    ],
    "Version": "2012-10-17"
}
EOT
}


##########################
#IRSA for Alethia agent   #
##########################
module "irsa_alethia_agent" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "irsa-alethia-${local.eks_name}"
  role_policy_arns = {
    alethia_agent_policy = aws_iam_policy.irsa_alethia_agent.arn
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks[0].oidc_provider_arn
      namespace_service_accounts = ["*:*"]
    }
  }
}

resource "aws_iam_policy" "irsa_alethia_agent" {

  name_prefix = "irsa_alethia_agent"
  description = "Policy for ServiceAccounts allowing calls to AWS metering API for cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "aws-marketplace:RegisterUsage",
                "aws-marketplace:MeterUsage"
            ],
            "Effect": "Allow",
            "Resource": "*"
        }
    ],
    "Version": "2012-10-17"
}
EOT
}

#############################################
#IRSA for fluent-bit access to cloudwatch   #
#############################################
module "irsa_fluentbit_cloudwatch" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "irsa-fluentbit-cloudwatch-${local.eks_name}"
  role_policy_arns = {
    aws_managed_policy = "arn:aws:iam::aws:policy/service-role/AWSAppSyncPushToCloudWatchLogs"
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks[0].oidc_provider_arn
      namespace_service_accounts = ["fluent-bit:fluent-bit"]
    }
  }
}

#############################################
#IRSA for Karpenter                         #
#############################################
resource "aws_iam_policy" "irsa_karpenter" {

  name_prefix = "irsa_karpenter"
  description = "Policy for Karpenter ServiceAccounts for cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "pricing:GetProducts",
                "ec2:DescribeSubnets",
                "ec2:DescribeSpotPriceHistory",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeLaunchTemplates",
                "ec2:DescribeInstances",
                "ec2:DescribeInstanceTypes",
                "ec2:DescribeInstanceTypeOfferings",
                "ec2:DescribeImages",
                "ec2:DescribeAvailabilityZones",
                "ec2:CreateTags",
                "ec2:CreateLaunchTemplate",
                "ec2:CreateFleet"
            ],
            "Effect": "Allow",
            "Resource": "*"
        },
        {
            "Action": [
                "ec2:TerminateInstances",
                "ec2:DeleteLaunchTemplate"
            ],
            "Condition": {
                "StringEquals": {
                    "ec2:ResourceTag/karpenter.sh/discovery": "${local.eks_name}"
                }
            },
            "Effect": "Allow",
            "Resource": "*"
        },
        {
            "Action": "ec2:RunInstances",
            "Condition": {
                "StringEquals": {
                    "ec2:ResourceTag/karpenter.sh/discovery": "${local.eks_name}"
                }
            },
            "Effect": "Allow",
            "Resource": "arn:aws:ec2:*:${var.aws_account_id}:launch-template/*"
        },
        {
            "Action": "ec2:RunInstances",
            "Effect": "Allow",
            "Resource": [
                "arn:aws:ec2:*::snapshot/*",
                "arn:aws:ec2:*::image/*",
                "arn:aws:ec2:*:*:volume/*",
                "arn:aws:ec2:*:*:subnet/*",
                "arn:aws:ec2:*:*:spot-instances-request/*",
                "arn:aws:ec2:*:*:security-group/*",
                "arn:aws:ec2:*:*:network-interface/*",
                "arn:aws:ec2:*:*:instance/*"
            ]
        },
        {
            "Action": "ssm:GetParameter",
            "Effect": "Allow",
            "Resource": "arn:aws:ssm:*:*:parameter/aws/service/*"
        },
        {
            "Action": "eks:DescribeCluster",
            "Effect": "Allow",
            "Resource": "arn:aws:eks:*:${var.aws_account_id}:cluster/${local.eks_name}"
        },
        {
            "Action": "iam:PassRole",
            "Effect": "Allow",
            "Resource": "arn:aws:iam::${var.aws_account_id}:role/${local.eks_name}-*"
        },
        {
            "Action": [
                "sqs:ReceiveMessage",
                "sqs:GetQueueUrl",
                "sqs:GetQueueAttributes",
                "sqs:DeleteMessage"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:sqs:${var.region}:${var.aws_account_id}:queue-${var.region}-${var.environment}-karpenter"
        },
        {
            "Action": [
                "iam:TagInstanceProfile",
                "iam:RemoveRoleFromInstanceProfile",
                "iam:GetInstanceProfile",
                "iam:DeleteInstanceProfile",
                "iam:CreateInstanceProfile",
                "iam:ListInstanceProfiles",
                "iam:AddRoleToInstanceProfile"
            ],
            "Effect": "Allow",
            "Resource": "*"
        }
    ],
    "Version": "2012-10-17"
}
EOT
}

module "irsa_karpenter" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "KarpenterIRSA-${local.eks_name}"
  role_policy_arns = {
    alethia_agent_policy = aws_iam_policy.irsa_karpenter.arn
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks[0].oidc_provider_arn
      namespace_service_accounts = ["${local.karpenter_namespace}:karpenter"]
    }
  }
}

##########################
#IRSA for AI Bedrock   #
##########################
module "irsa_ai_bedrock" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "ai-bedrock-${local.eks_name}"
  role_policy_arns = {
    aws_managed_policy            = "arn:aws:iam::aws:policy/AmazonBedrockFullAccess",
    irsa_ai_bedrock_custom_policy = aws_iam_policy.irsa_ai_bedrock_custom.arn
    irsa_ai_bedrock_s3_policy     = aws_iam_policy.irsa_ai_bedrock_s3.arn

  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks[0].oidc_provider_arn
      namespace_service_accounts = ["*:*"]
    }
  }
}
resource "aws_iam_policy" "irsa_ai_bedrock_custom" {

  name_prefix = "irsa_ai_bedrock_custom"
  description = "Policy for ServiceAccounts allowing invoking bedrock model"
  policy      = <<EOT
  {
    "Statement": [
        {
             "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:bedrock:${var.region}:${var.aws_account_id}:*/*"
        }
    ],
    "Version": "2012-10-17"
  }
 EOT
}
resource "aws_iam_policy" "irsa_ai_bedrock_s3" {

  name_prefix = "irsa_ai_bedrock_s3"
  description = "Policy for ServiceAccounts allowing S3 bucket access"
  policy      = <<EOT
  {
    "Statement": [
		{
			"Effect": "Allow",
			"Action": [
				"s3:ListBucket"
			],
			"Resource": "arn:aws:s3:::*"
		},
		{
			"Effect": "Allow",
			"Action": [
				"s3:GetObject",
				"s3:PutObject"
			],
			"Resource": "arn:aws:s3:::*/*"
		}
	],
    "Version": "2012-10-17"
  }
 EOT  

}
#############################################
#IRSA for in-cluster image builds (W2)      #
#############################################
# The kaniko build Job's ServiceAccount assumes this role to push built service images into
# the project's ECR repositories — keyless (no registry credentials ever minted or mounted).
# The SA coordinates are a fixed contract with the BUILD job renderer (packages/core/build):
# namespace "alethia-build", ServiceAccount "kaniko-builder".
locals {
  ecr_build_namespace       = "alethia-build"
  ecr_build_service_account = "kaniko-builder"
}

resource "aws_iam_policy" "irsa_ecr_build" {
  count = var.provision_ecr ? 1 : 0

  name_prefix = "irsa_ecr_build"
  description = "ECR push for the in-cluster build ServiceAccount of cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "ecr:GetAuthorizationToken"
            ],
            "Effect": "Allow",
            "Resource": "*",
            "Sid": "EcrLogin"
        },
        {
            "Action": [
                "ecr:BatchCheckLayerAvailability",
                "ecr:BatchGetImage",
                "ecr:GetDownloadUrlForLayer",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload",
                "ecr:PutImage"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:ecr:${var.region}:${var.aws_account_id}:repository/${var.project_name}-*",
            "Sid": "EcrPushProjectRepos"
        }
    ],
    "Version": "2012-10-17"
}
EOT
}

module "irsa_ecr_build" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  count   = var.provision_ecr ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "ecr-build-${local.eks_name}"
  role_policy_arns = {
    ecr_build_policy = aws_iam_policy.irsa_ecr_build[0].arn
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks[0].oidc_provider_arn
      namespace_service_accounts = ["${local.ecr_build_namespace}:${local.ecr_build_service_account}"]
    }
  }
}

##########################
#IRSA for S3 bucket   #
##########################
module "s3_bucket_irsa_role" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "s3-bucket-${local.eks_name}"
  role_policy_arns = {
    aws_managed_policy = "arn:aws:iam::aws:policy/AmazonS3FullAccess"
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks[0].oidc_provider_arn
      namespace_service_accounts = ["*:*"]
    }
  }
}