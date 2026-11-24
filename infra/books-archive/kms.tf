# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The customer-managed key the archive (SSE-KMS, with an S3 Bucket Key) is encrypted with.
#
# A deleted or disabled key makes every object encrypted under it unreadable, Object Lock or not —
# eleven years of records lost to one API call. So:
#   · prevent_destroy — tofu refuses any plan that would destroy it (checks.tf reads this file);
#   · deletion_window_in_days = 30, the maximum, so a scheduled deletion can still be cancelled;
#   · the key policy DENIES kms:ScheduleKeyDeletion, kms:DisableKey and kms:PutKeyPolicy to every
#     principal except the admins (main.tf admin_principal_patterns). PutKeyPolicy is in the list
#     because without it anyone holding kms:* through IAM could rewrite the policy to drop the Deny.
#
# This differs from infra/backup-account/kms.tf, which deliberately carries NO Deny (a key policy
# that locks out its admins cannot be repaired from inside the account). The lockout risk here is
# bounded: the Deny names admins by aws:PrincipalArn, which matches a role by NAME, so if both admin
# roles were ever deleted, recreating alethia-backup-admin (infra/backup-account/bootstrap) restores
# the exemption. And the Allow that delegates to IAM is untouched, so the key keeps working for the
# bucket in the meantime. The tofu apply runs as alethia-backup-admin, which is exempt, so KMS's own
# policy-lockout safety check passes without BypassPolicyLockoutSafetyCheck.
#
# The non-admin identities get the key only through their IAM policies, each conditioned on
# kms:ViaService = S3, so it is usable only THROUGH S3 — never by a direct Decrypt call.

resource "aws_kms_key" "archive" {
  description             = "Alethia immutable books archive (S3, Object Lock COMPLIANCE 11 y), alethia-backup account."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.archive_kms.json

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The archive must be out of reach of everything that can reach production; it needs its own account."
    }
  }
}

resource "aws_kms_alias" "archive" {
  name          = local.kms_alias_name
  target_key_id = aws_kms_key.archive.key_id
}

locals {
  # Named once so checks.tf and the test read the same list the policy denies.
  kms_admin_only_actions = ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"]
}

data "aws_iam_policy_document" "archive_kms" {
  statement {
    sid       = "AccountIamGovernsTheKey"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.backup_account_id}:root"]
    }
  }

  statement {
    sid       = "OnlyAdminsMayDeleteDisableOrRepolicyTheKey"
    effect    = "Deny"
    actions   = local.kms_admin_only_actions
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
