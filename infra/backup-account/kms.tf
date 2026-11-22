# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The customer-managed key the bucket (SSE-KMS, with an S3 Bucket Key) and the drill secret are
# encrypted with. This is the ACCESS-CONTROL layer; the age envelope backup.sh applies is the
# end-to-end layer, and nothing at AWS can read through that.
#
# A deleted key makes every object encrypted under it unreadable, Object Lock or not. So:
#   · prevent_destroy — tofu refuses any plan that would destroy it (checks.tftest.hcl asserts this
#     file carries it);
#   · deletion_window_in_days = 30, the maximum, so a scheduled deletion can still be cancelled a
#     month later.
#
# The key policy delegates to the account's IAM and grants nothing directly. Each identity's IAM
# policy grants exactly the KMS actions it needs, each conditioned on kms:ViaService, so the key is
# usable only THROUGH S3 (or Secrets Manager, for the drill) — never by a direct Decrypt call.
#
# There is deliberately no Deny in the key policy. A KMS key policy that locks out its admins cannot
# be repaired from inside the account (unlike a bucket policy, which the root user can always
# delete), and the non-admin identities hold no key-management action to deny.

resource "aws_kms_key" "backup" {
  description             = "Alethia off-box production backups (S3 bucket + drill secret), alethia-backup account."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.backup_kms.json

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The backups exist to be out of reach of everything that can reach production; they need their own account."
    }
  }
}

resource "aws_kms_alias" "backup" {
  name          = local.kms_alias_name
  target_key_id = aws_kms_key.backup.key_id
}

data "aws_iam_policy_document" "backup_kms" {
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
}
