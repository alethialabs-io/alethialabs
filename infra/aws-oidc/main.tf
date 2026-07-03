# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Least-privilege GitHub-OIDC deploy roles for the workflows that still used static
# AWS keys — control-plane/status infra (state only) and runner releases (ECR + ECS).
# Mirrors infra/email-ses/bootstrap: all IAM lives here (apply ONCE with an admin
# identity); every steady-state CI run assumes one of these roles via OIDC with no
# stored keys. The OIDC provider already exists (created by the SES bootstrap) — this
# module ADOPTS it, never re-creates it.

locals {
  tags = {
    project = "alethia"
    role    = "aws-oidc-bootstrap"
    managed = "opentofu"
  }

  account_id = data.aws_caller_identity.current.account_id

  oidc_provider_arn = var.oidc_provider_arn != "" ? var.oidc_provider_arn : data.aws_iam_openid_connect_provider.github.arn

  # Only Actions runs on the apply branch (never PRs, never forks) may assume a role.
  oidc_sub = "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}"
}

data "aws_caller_identity" "current" {}

# Adopt the account-wide GitHub OIDC provider (created once by infra/email-ses/bootstrap).
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# Shared trust: GitHub OIDC from the apply branch, plus an optional admin escape hatch
# for local import/apply. Reused by both deploy roles.
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
      values   = [local.oidc_sub]
    }
  }

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
