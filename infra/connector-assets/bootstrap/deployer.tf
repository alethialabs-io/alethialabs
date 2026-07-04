# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The least-privilege deploy role for the main connector-assets stack. Assumed by
# GitHub Actions via OIDC (no stored keys) and, optionally, by an admin principal for
# local import/apply. Its policy grants exactly what `tofu apply` of the main stack
# needs — manage the one assets bucket + its objects, and read/write the state object —
# and no iam:* at all.

data "aws_iam_policy_document" "deployer_trust" {
  statement {
    sid     = "GithubOIDC"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      # Trust both the branch ref sub and the environment sub (the apply job sets
      # `environment: <github_environment>`). StringEquals value-list = OR.
      values = [
        "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}",
        "repo:${var.github_repo}:environment:${var.github_environment}",
      ]
    }
  }

  # Optional: let an admin principal assume the role for local import/apply.
  dynamic "statement" {
    for_each = length(var.admin_principal_arns) > 0 ? [1] : []
    content {
      sid     = "AdminAssume"
      effect  = "Allow"
      actions = ["sts:AssumeRole"]
      principals {
        type        = "AWS"
        identifiers = var.admin_principal_arns
      }
    }
  }
}

resource "aws_iam_role" "deployer" {
  name               = "alethia-connector-assets-deployer"
  description        = "Least-privilege deploy role for the connector-assets OpenTofu stack."
  assume_role_policy = data.aws_iam_policy_document.deployer_trust.json
  tags               = local.tags
}

# Least-privilege permissions — scoped to the single assets bucket + the state object.
data "aws_iam_policy_document" "deployer_permissions" {
  # Create + manage exactly the connector-assets bucket (config + public-read policy).
  statement {
    sid    = "AssetsBucket"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:GetBucketTagging",
      "s3:PutBucketTagging",
      "s3:GetBucketPolicy",
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
      "s3:GetBucketPublicAccessBlock",
      "s3:PutBucketPublicAccessBlock",
      "s3:GetBucketOwnershipControls",
      "s3:PutBucketOwnershipControls",
      "s3:GetBucketAcl",
    ]
    resources = ["arn:aws:s3:::${var.bucket_name}"]
  }

  # Read/write the artifact objects in that bucket.
  statement {
    sid    = "AssetsObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectTagging",
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
    ]
    resources = ["arn:aws:s3:::${var.bucket_name}/*"]
  }

  # OpenTofu state — the deploy role authenticates the S3 backend itself (same
  # account), so no static state keys. ListBucket on the bucket + object RW (state
  # object + the native .tflock lock object).
  statement {
    sid       = "TofuStateBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}"]
  }
  statement {
    sid       = "TofuStateObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/connector-assets/*"]
  }
}

resource "aws_iam_role_policy" "deployer" {
  name   = "alethia-connector-assets-deploy"
  role   = aws_iam_role.deployer.id
  policy = data.aws_iam_policy_document.deployer_permissions.json
}
