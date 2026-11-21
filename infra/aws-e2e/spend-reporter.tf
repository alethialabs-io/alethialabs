# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ── Weekly spend report role, in the e2e account (`alethia-spend-reporter`) ─────────────────────
# A member account's Cost Explorer shows ONLY that account's own spend, so once E2E_AWS_ROLE_ARN
# points here (README step 6) the platform account's reporter (infra/aws-oidc/spend-reporter.tf) no
# longer sees a dollar of AWS e2e spend. This is the second reader the report assumes, as
# vars.SPEND_REPORTER_E2E_ROLE_ARN. The organization's consolidated bill would see both accounts, but
# it lives in the management account, which this repository does not grant from.
#
# Assumed by .github/workflows/spend-report.yml and by nothing else. It READS Cost Explorer (this
# account's spend) and the tagging API (the e2e leak list). It writes nothing, and — unlike the
# platform reporter — it holds NO secret read: the SES sender key the report is mailed with is read in
# the platform account, through that account's role.
#
# TRUST — one subject, the same as the platform reporter's: `repo:<repo>:environment:spend-report`.
# What makes it safe is GitHub-side: that environment is restricted to `main`
# (infra/github/environments.tf, `spend_report`). Already applied for the platform reporter, so this
# role adds no new ordering constraint. Federation only: no AdminAssume statement, as with every role
# in this account (the maintainer reaches it through alethia-e2e-admin, which can read CE itself).
#
# PATH /alethia-e2e/, ON PURPOSE. The nightly role holds iam:* in this account. Under this path the
# boundary's DenyTamperWithGuardrails (e2e-nightly.tf) already forbids it to rewrite this role's trust
# or policy, or to delete it — so an e2e run cannot widen a report identity into a second way in, nor
# blind the report to its own spend. Outside the path it could do both. The cost is only that the ARN
# carries the path: arn:aws:iam::<e2e>:role/alethia-e2e/alethia-spend-reporter.

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
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [local.spend_reporter_sub]
    }
  }
}

resource "aws_iam_role" "spend_reporter" {
  name                 = "alethia-spend-reporter"
  path                 = local.e2e_path
  description          = "Least-priv OIDC role for spend-report.yml in the e2e account - Cost Explorer + tag reads only. No secrets, writes nothing."
  assume_role_policy   = data.aws_iam_policy_document.spend_reporter_trust.json
  max_session_duration = 3600

  # The trust names the GitHub provider by its BUILT ARN (oidc.tf), which carries no dependency edge.
  depends_on = [aws_iam_openid_connect_provider.github]

  lifecycle {
    precondition {
      condition     = var.e2e_account_id != var.alethia_account_id
      error_message = "e2e_account_id equals alethia_account_id — the platform account already has its own alethia-spend-reporter (infra/aws-oidc)."
    }
  }
}

data "aws_iam_policy_document" "spend_reporter" {
  # Cost Explorer has no resource-level permissions — every CE action authorizes against "*" only.
  statement {
    sid       = "CostExplorerRead"
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage", "ce:GetCostForecast"]
    resources = ["*"]
  }
  # The leak list: resources still carrying an e2e handle. Resource-less too. No tag:TagResources.
  statement {
    sid       = "TagRead"
    effect    = "Allow"
    actions   = ["tag:GetResources"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "spend_reporter" {
  name   = "alethia-spend-report-read"
  role   = aws_iam_role.spend_reporter.id
  policy = data.aws_iam_policy_document.spend_reporter.json
}
