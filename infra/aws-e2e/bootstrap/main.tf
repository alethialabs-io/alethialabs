# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# aws-e2e BOOTSTRAP — the one resource the main stack cannot create for itself: the role it applies
# THROUGH.
#
# A member account created by AWS Organizations comes with exactly one way in:
# OrganizationAccountAccessRole, assumable only from the organization's management account. That
# account belongs to the organization, not to Alethia, so the main stack must not need it on every
# apply. This bootstrap is applied ONCE with management-account credentials (`management_profile`)
# and creates `alethia-e2e-admin`, a role in the e2e account that trusts named principals in the
# Alethia platform account. From then on every apply of ../ uses the maintainer's ordinary Alethia
# SSO session for both the state backend and (via this role) the provider.
#
# Nothing in the e2e account is trusted BY the Alethia account: the trust runs one way only, from
# Alethia into e2e. That direction is the point of the move — a compromise of the e2e account (whose
# nightly role has iam:*) gains nothing in the account that holds prod.

provider "aws" {
  region  = "us-east-1"
  profile = var.management_profile

  assume_role {
    role_arn     = "arn:aws:iam::${var.e2e_account_id}:role/OrganizationAccountAccessRole"
    session_name = "alethia-aws-e2e-bootstrap"
  }

  # A refusal, not a check: if the assumed role resolves to any other account, the provider errors
  # before it reads or writes anything.
  allowed_account_ids = [var.e2e_account_id]

  default_tags {
    tags = {
      project = "alethia"
      role    = "aws-e2e-bootstrap"
      managed = "opentofu"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "admin_trust" {
  statement {
    sid     = "AlethiaAdmins"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    # The account root DELEGATES to the Alethia account's IAM; the condition then narrows the caller
    # to the exact ARNs listed. Both must pass. (A bare role-ARN principal would also work but is
    # resolved to the role's unique id when saved, so a re-provisioned SSO permission set would
    # silently lock the maintainer out.)
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.alethia_account_id}:root"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = var.admin_principal_arns
    }
  }
}

resource "aws_iam_role" "admin" {
  name                 = var.admin_role_name
  path                 = "/"
  description          = "Break-glass + apply role for the alethia-e2e account, assumed from the Alethia platform account. Created by infra/aws-e2e/bootstrap."
  assume_role_policy   = data.aws_iam_policy_document.admin_trust.json
  max_session_duration = var.admin_max_session_seconds

  lifecycle {
    precondition {
      condition     = var.e2e_account_id != var.alethia_account_id
      error_message = "e2e_account_id equals alethia_account_id: the whole point of this stack is that they are DIFFERENT accounts."
    }
    precondition {
      condition     = alltrue([for a in var.admin_principal_arns : startswith(a, "arn:aws:iam::${var.alethia_account_id}:")])
      error_message = "every admin_principal_arns entry must be a principal in alethia_account_id — the e2e admin role trusts the Alethia platform account and nothing else."
    }
  }
}

# Account admin in the e2e account, deliberately: the main stack creates the OIDC provider, IAM
# roles with a permissions boundary, a Route 53 zone, SNS and a Budget, and its next change cannot be
# predicted. The blast radius of this grant is the e2e account itself, which is the account designed
# to be expendable. The protection that matters — the e2e nightly role cannot edit or assume this
# role — is in ../e2e-nightly.tf (DenyTamperWithBreakGlass + DenyRoleHop).
resource "aws_iam_role_policy_attachment" "admin" {
  role       = aws_iam_role.admin.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
