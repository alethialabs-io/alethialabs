# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
  # A job that sets `environment: <env>` gets sub `...:environment:<env>`; a plain job
  # on the apply branch gets `...:ref:refs/heads/<branch>`. Trust BOTH forms (a
  # StringEquals value-list is an OR) so the same role works whether or not the job
  # pins an environment. The environment is branch-restricted to the apply branch (GitHub
  # deployment-branch policy), so the environment sub can't be minted off another branch.
  oidc_subs = [
    "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}",
    "repo:${var.github_repo}:environment:${var.github_environment}",
  ]
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
      values   = local.oidc_subs
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
