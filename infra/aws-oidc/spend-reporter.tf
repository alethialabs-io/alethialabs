# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ── Weekly spend report role (`alethia-spend-reporter`) ─────────────────────────────────────────
# Assumed by .github/workflows/spend-report.yml, and by nothing else. It READS: Cost Explorer (the
# account's spend), the tagging API (the e2e leak list) and the one prod secret (for the SES sender key
# of the alethia-email account, which the report is mailed with). It writes nothing anywhere.
#
# TRUST — ONE subject, an ENVIRONMENT, never the shared `deployer_trust`. `deployer_trust` admits
# `ref:refs/heads/main`, which every workflow on main presents; this role must be reachable from
# the spend report only. AWS can pin `sub` and `aud` but not `job_workflow_ref`, so the narrowest
# subject GitHub can mint here is `repo:<repo>:environment:<spend_reporter_environment>` — the job
# that selects that environment, and no other. The same shape as `cli-release` on the reader
# (roles.tf), for the same reason.
#
# ⚠️ WHAT MAKES THAT SAFE IS GITHUB-SIDE, NOT HERE: the environment must be restricted to `main` by a
# deployment-branch policy (infra/github/environments.tf, `spend_report`). An environment that does
# not exist is CREATED, UNRESTRICTED, the first time any job names it — at which point a job on any
# branch could select it and read the prod secret through this role. So infra/github is applied
# FIRST, and this stack after it. scripts/spend-report/README.md carries the order.
#
# THE SECRET GRANT IS THE WHOLE BLOB. Secrets Manager authorizes `GetSecretValue` per SECRET, not
# per JSON key, so this role can read every key in `alethia/prod/env`, not only the
# `ALETHIA_SES_*` sender keys. That is the same reach `alethia-deploy-reader` already has; narrowing
# it would mean a separate secret holding the sender key alone (a new container + a second writer in bootstrap-secrets.sh),
# which is a follow-up rather than something this role can do by itself.

locals {
  spend_reporter_sub = "repo:${var.github_repo}:environment:${var.spend_reporter_environment}"
}

data "aws_iam_policy_document" "spend_reporter_trust" {
  statement {
    sid     = "GithubOIDCSpendReport"
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
      values   = [local.spend_reporter_sub]
    }
  }

  # The same optional admin escape hatch every role here carries, for a local dry run of the report.
  # Empty by default, so the trust is OIDC-only.
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

resource "aws_iam_role" "spend_reporter" {
  name               = "alethia-spend-reporter"
  description        = "Least-priv OIDC role for spend-report.yml - Cost Explorer + tag reads + read the prod secret. Writes nothing."
  assume_role_policy = data.aws_iam_policy_document.spend_reporter_trust.json
  # A report is a handful of API calls; the 1h default is ample.
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "spend_reporter" {
  # Cost Explorer has no resource-level permissions — every CE action authorizes against "*" only
  # (Service Authorization Reference, "Resource types: none"). These two are reads.
  statement {
    sid       = "CostExplorerRead"
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage", "ce:GetCostForecast"]
    resources = ["*"]
  }
  # The leak list: resources still carrying an e2e handle (alethia:project-id / alethia:e2e-run).
  # The tagging API is likewise resource-less. Read-only; no tag:TagResources.
  statement {
    sid       = "TagRead"
    effect    = "Allow"
    actions   = ["tag:GetResources"]
    resources = ["*"]
  }
  # The SES sender key the report is mailed with. One secret, read-only — see the header for why this
  # cannot be one KEY of that secret.
  statement {
    sid       = "AsmRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.prod_env.arn]
  }
}

resource "aws_iam_role_policy" "spend_reporter" {
  name   = "alethia-spend-report-read"
  role   = aws_iam_role.spend_reporter.id
  policy = data.aws_iam_policy_document.spend_reporter.json
}
