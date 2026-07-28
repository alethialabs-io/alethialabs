# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-account keyless Secrets Manager — TARGET-account trust bootstrap (Model B).
#
# You run this in the account that OWNS the secrets (account B), ONCE. It creates a least-privilege
# read role that trusts your Alethia cluster's external-secrets identity (account A) and grants ONLY
# Secrets Manager read. Your cluster holds no key: the in-cluster External Secrets Operator assumes this
# role via STS and reads across the account boundary. Copy the printed role ARN back into the Alethia
# `aws-sm-xacct` secrets connector's "Target Role ARN".
#
# Prereqs: OpenTofu/Terraform authenticated to the SECRETS account (B); the cluster's external-secrets
# IRSA role ARN (the `aws-sm-xacct` connector shows it, or read it from the project's
# `eks_irsa_external_secrets_arn` output).

variable "cluster_external_secrets_role_arn" {
  description = "The Alethia cluster's external-secrets IRSA role ARN (account A) that this target role will trust. Shown by the aws-sm-xacct connector / the project's eks_irsa_external_secrets_arn output."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+", var.cluster_external_secrets_role_arn))
    error_message = "cluster_external_secrets_role_arn must be a full IAM role ARN (arn:aws:iam::<account>:role/<name>)."
  }
}

variable "role_name" {
  description = "Name of the read role to create in the secrets account."
  type        = string
  default     = "AlethiaSecretsReadRole"
}

variable "secret_arns" {
  description = "Secrets Manager secret ARNs the cluster may read. Name exactly the secrets you intend to share (least-privilege) — deliberately no default, because a '*' fallback silently grants read on EVERY secret in this account."
  type        = list(string)

  validation {
    condition     = length(var.secret_arns) > 0
    error_message = "Name at least one secret ARN — grant read per-secret rather than account-wide."
  }
}

variable "kms_key_arns" {
  description = "Optional: KMS key ARNs to grant kms:Decrypt on, for secrets encrypted with a customer-managed key (CMK). Leave empty for the AWS-managed Secrets Manager key."
  type        = list(string)
  default     = []
}

variable "external_id" {
  description = "Optional external id required on the assume (defense in depth). Leave empty to omit. If you set it, enter the SAME value in the connector's External ID field (provider_config.external_id) — the operator sends it as spec.provider.aws.externalID, and STS rejects the assume when the two disagree."
  type        = string
  default     = ""
}

# Trust ONLY the cluster's external-secrets IRSA role — a specific role in account A, nothing else. A
# different principal (or a wrong external id, when set) is rejected.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.cluster_external_secrets_role_arn]
    }
    dynamic "condition" {
      for_each = var.external_id == "" ? [] : [var.external_id]
      content {
        test     = "StringEquals"
        variable = "sts:ExternalId"
        values   = [condition.value]
      }
    }
  }
}

# Read ONLY — GetSecretValue + DescribeSecret. No write, no delete, no rotation.
data "aws_iam_policy_document" "read" {
  statement {
    sid       = "ReadSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = var.secret_arns
  }
  dynamic "statement" {
    for_each = length(var.kms_key_arns) == 0 ? [] : [1]
    content {
      sid       = "DecryptWithCMK"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = var.kms_key_arns
    }
  }
}

resource "aws_iam_role" "read" {
  name               = var.role_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
  description        = "Least-privilege Secrets Manager read role assumed by the Alethia cluster's external-secrets operator (cross-account keyless)."
}

resource "aws_iam_role_policy" "read" {
  name   = "secrets-read"
  role   = aws_iam_role.read.id
  policy = data.aws_iam_policy_document.read.json
}

output "target_role_arn" {
  value       = aws_iam_role.read.arn
  description = "Copy this into the Alethia aws-sm-xacct connector's Target Role ARN."
}
