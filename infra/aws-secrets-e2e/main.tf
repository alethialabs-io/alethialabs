# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Account B for the cross-account keyless secret-manager e2e (#1268).
#
# The e2e provisions a cluster in account A and proves a workload reads a secret that lives HERE,
# in account B, with no credential anywhere — ESO assumes the read role below using the cluster's
# own IRSA identity. This stack is the customer's side of Model B, applied ONCE by hand.
#
# It is NOT the shipped customer bootstrap. That is infra/connector/aws/secrets-xacct, which trusts
# an exact role ARN and must keep doing so. This stack trusts a narrow PRINCIPAL PATTERN instead,
# because the e2e cluster is destroyed and recreated every night and an exact-ARN trust cannot
# survive that (see cluster_eso_role_pattern). The divergence is deliberate, bounded, and recorded
# on docs/testing/xacct-secrets-parity.md — the e2e proves the ESO READ PATH, not the exact trust
# policy shape the customer module writes.

data "aws_caller_identity" "current" {}

# The canary. One secret, one value, read across the boundary and compared by sha256.
resource "aws_secretsmanager_secret" "canary" {
  name        = var.secret_name
  description = "Alethia cross-account e2e canary — read from account ${var.cluster_account_id} by the cluster's external-secrets identity."
  tags        = var.tags

  # The e2e is re-applied freely; a scheduled deletion would otherwise block recreating the same
  # name for up to 30 days and wedge the lane on a ResourceExists error.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "canary" {
  secret_id     = aws_secretsmanager_secret.canary.id
  secret_string = var.canary_value
}

# Trust: account A's external-secrets IRSA role, and nothing else.
#
# The account-root principal here does NOT mean "any principal in account A" — it delegates trust
# to account A's IAM, and the ArnLike condition then narrows the actual caller to one role-name
# shape. Both must pass. Without the condition this would be an account-wide trust, which is why
# checks.tf refuses a pattern that could match everything.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.cluster_account_id}:root"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values   = ["arn:aws:iam::${var.cluster_account_id}:role/${var.cluster_eso_role_pattern}"]
    }

    # Optional confused-deputy control, mirroring the connector's external_id field.
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

resource "aws_iam_role" "read" {
  name               = var.role_name
  description        = "Read-only access to the Alethia e2e canary secret for account ${var.cluster_account_id}'s external-secrets operator."
  assume_role_policy = data.aws_iam_policy_document.trust.json
  tags               = var.tags
}

# Least privilege: get/describe on exactly ONE secret ARN. Never a wildcard — the shipped connector
# module refuses an empty secret list for the same reason, and an e2e that granted more than the
# product does would prove less than it appears to.
data "aws_iam_policy_document" "read" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.canary.arn]
  }
}

resource "aws_iam_role_policy" "read" {
  name   = "alethia-e2e-secrets-read"
  role   = aws_iam_role.read.id
  policy = data.aws_iam_policy_document.read.json
}
