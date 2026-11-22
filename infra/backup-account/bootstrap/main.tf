# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# backup-account BOOTSTRAP: the one resource the main stack cannot create for itself, the role it
# applies THROUGH. The same shape as infra/email-ses-account/bootstrap and infra/aws-e2e/bootstrap.
#
# A member account created by AWS Organizations comes with exactly one way in:
# OrganizationAccountAccessRole, assumable only from the organization's management account. This
# bootstrap is applied ONCE with management-account credentials (`management_profile`) and creates
# `alethia-backup-admin`, a role in the backup account that trusts named principals in the Alethia
# platform account. From then on every apply of ../ uses the maintainer's ordinary Alethia SSO
# session for both the state backend and (via this role) the provider.
#
# Nothing in the backup account is trusted BY the Alethia account: the trust runs one way only. The
# main stack's bucket policy then names this role and the account's Identity Center admins as the
# only principals allowed to delete, change retention, or change the bucket's own policy — the
# management account's OrganizationAccountAccessRole is deliberately NOT among them.

provider "aws" {
  region  = var.backup_region
  profile = var.management_profile

  assume_role {
    role_arn     = "arn:aws:iam::${var.backup_account_id}:role/OrganizationAccountAccessRole"
    session_name = "alethia-backup-bootstrap"
  }

  # A refusal, not a check: if the assumed role resolves to any other account, the provider errors
  # before it reads or writes anything.
  allowed_account_ids = [var.backup_account_id]

  default_tags {
    tags = {
      project = "alethia"
      role    = "backup-account-bootstrap"
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
    # to the exact ARNs listed. Both must pass. (A bare role-ARN principal is resolved to the role's
    # unique id when saved, so a re-provisioned SSO permission set would silently lock the
    # maintainer out.)
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
  description          = "Apply role for the alethia-backup account, assumed from the Alethia platform account. Created by infra/backup-account/bootstrap."
  assume_role_policy   = data.aws_iam_policy_document.admin_trust.json
  max_session_duration = var.admin_max_session_seconds

  lifecycle {
    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id: the backups exist to be OUT of the platform account's reach, so they must be DIFFERENT accounts."
    }
    precondition {
      condition     = alltrue([for a in var.admin_principal_arns : startswith(a, "arn:aws:iam::${var.alethia_account_id}:")])
      error_message = "every admin_principal_arns entry must be a principal in alethia_account_id — the backup admin role trusts the Alethia platform account and nothing else."
    }
  }
}

# Account admin in the backup account, deliberately: the main stack creates IAM, a KMS key, an S3
# bucket, a VPC, a launch template, a secret and a budget, and its next change cannot be predicted.
# The blast radius is the backup account itself. What this role CANNOT do even so is shorten a
# locked object's retention: Object Lock COMPLIANCE refuses that to every principal, root included.
resource "aws_iam_role_policy_attachment" "admin" {
  role       = aws_iam_role.admin.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
