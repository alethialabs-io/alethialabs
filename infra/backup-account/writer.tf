# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# backup-writer: the identity the production box writes backups as. An IAM user with a static key,
# because the Hetzner box has no identity provider AWS can federate (design §A.3, decision A-5).
#
# What it can do: put, get and list objects under <backup_prefix>/ in this one bucket, and use the
# bucket's key only through S3. From the box's addresses only.
# What it can NEVER do: delete an object or a version, add a delete marker, change retention or a
# legal hold, abort an upload, or touch anything else in the account. A box compromise therefore
# yields read access to age ciphertext the box cannot decrypt, and the ability to ADD copies — never
# to remove one. Retention is the bucket's lifecycle (bucket.tf), not this user's.
#
# The ACCESS KEY IS NOT CREATED HERE. An aws_iam_access_key resource writes the secret into the
# state. The maintainer mints it with the CLI straight into the vault and /etc/alethia/backup.env
# (README step 6). checks.tf and checks.tftest.hcl assert that no *.tf file in this stack declares
# an access-key resource.

resource "aws_iam_user" "writer" {
  name = local.writer_user_name
  path = local.writer_user_path

  lifecycle {
    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The backups exist to be out of reach of everything that can reach production; they need their own account."
    }
  }
}

data "aws_iam_policy_document" "writer" {
  statement {
    sid       = "PutAndGetBackupObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${local.bucket_arn}/${var.backup_prefix}/*"]
    condition {
      test     = "IpAddress"
      variable = "aws:SourceIp"
      values   = var.writer_source_cidrs
    }
  }

  # rclone lists under the prefix (`check`, `lsf`); RCLONE_S3_NO_CHECK_BUCKET=true in
  # deploy/prod/backup/lib.sh means it never asks for the bucket itself.
  statement {
    sid       = "ListBackupPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [var.backup_prefix, "${var.backup_prefix}/*"]
    }
    condition {
      test     = "IpAddress"
      variable = "aws:SourceIp"
      values   = var.writer_source_cidrs
    }
  }

  # S3 calls KMS on the writer's behalf to encrypt (GenerateDataKey) and to read back (Decrypt) under
  # the bucket key. ViaService confines both to requests that came through S3 — which the statements
  # above have already confined to the box.
  statement {
    sid       = "UseTheBucketKeyThroughS3Only"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [local.kms_key_arn_pattern]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.kms_alias_name]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.s3_via_service]
    }
  }

  # Belt and braces for the IP lock: anything this key does from elsewhere is refused, except the
  # calls AWS services make on its behalf (S3 → KMS), which carry the SERVICE's address.
  statement {
    sid       = "DenyFromAnywhereButTheBox"
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]
    condition {
      test     = "NotIpAddress"
      variable = "aws:SourceIp"
      values   = var.writer_source_cidrs
    }
    condition {
      test     = "Bool"
      variable = "aws:ViaAWSService"
      values   = ["false"]
    }
  }
}

resource "aws_iam_user_policy" "writer" {
  name   = "alethia-backup-write"
  user   = aws_iam_user.writer.name
  policy = data.aws_iam_policy_document.writer.json
}
