# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The books connectors' credentials (Revolut Business API key + Ed25519 signing key, Paddle API key,
# the books@ Google OAuth refresh token) — one JSON secret the books workflow reads as books-monthly.
#
# A SHELL: this stack creates the secret and its resource policy, never a value. An
# aws_secretsmanager_secret_version would write the credentials into the state; checks.tf refuses
# one. The maintainer fills it once from the admin SSO session (README "Fill the connectors secret").
#
# Encrypted with the AWS-managed aws/secretsmanager key, not the archive's CMK, on purpose: that keeps
# books-monthly's KMS rights to "through S3 only" (oidc.tf), and the resource policy below — not the
# key — is what decides who may read the value.

resource "aws_secretsmanager_secret" "connectors" {
  name                    = local.connectors_secret_name
  description             = "Books connectors (Revolut, Paddle, Google) for the books repository's workflow. Value set out of band; read by books-monthly. Created by infra/books-archive."
  recovery_window_in_days = 30

  lifecycle {
    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The archive must be out of reach of everything that can reach production; it needs its own account."
    }
  }
}

# Only books-monthly and the admins may read the value. Any other principal in the account —
# whatever its IAM policy says — is refused.
data "aws_iam_policy_document" "connectors_secret" {
  statement {
    sid       = "OnlyBooksMonthlyAndAdminsReadTheValue"
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = concat(local.admin_principal_patterns, [local.books_role_arn])
    }
  }

  # Only the admins may replace the value, delete the secret, or change this policy — so another
  # principal in the account (the management account's OrganizationAccountAccessRole included) can
  # neither swap in credentials of its choosing nor remove the Deny above.
  statement {
    sid       = "OnlyAdminsChangeTheSecret"
    effect    = "Deny"
    actions   = local.secret_admin_only_actions
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = local.admin_principal_patterns
    }
  }
}

locals {
  secret_admin_only_actions = [
    "secretsmanager:PutSecretValue",
    "secretsmanager:UpdateSecret",
    "secretsmanager:DeleteSecret",
    "secretsmanager:PutResourcePolicy",
    "secretsmanager:DeleteResourcePolicy",
    "secretsmanager:RotateSecret",
  ]
}

resource "aws_secretsmanager_secret_policy" "connectors" {
  secret_arn = aws_secretsmanager_secret.connectors.arn
  policy     = data.aws_iam_policy_document.connectors_secret.json
}
