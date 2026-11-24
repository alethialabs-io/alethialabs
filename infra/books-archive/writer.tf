# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# console-books-writer: the identity the production console exports its documents as (фактури,
# credit notes, PDFs, the monthly Paddle фактура — books lane B2). An IAM user with a static key,
# because the Hetzner box has no identity provider AWS can federate (the same reason as
# infra/backup-account/writer.tf).
#
# What it can do: PutObject under inbound/console/ in this one bucket, using the bucket's key only
# through S3, from the box's addresses only.
# What it can NEVER do: read anything back, list, delete, overwrite a locked version, change
# retention or a legal hold, abort an upload, or touch anything else in the account. A box compromise
# therefore yields the ability to ADD documents under inbound/console/ — never to read, alter or
# remove one already archived (every overwrite is a new version; the old one stays locked).
#
# The ACCESS KEY IS NOT CREATED HERE. An aws_iam_access_key resource writes the secret into the
# state. ops/mint-console-writer-key.sh mints it straight into the production vault
# `alethia/prod/env` (BOOKS_ARCHIVE_ACCESS_KEY_ID / BOOKS_ARCHIVE_SECRET_ACCESS_KEY). checks.tf and
# checks.tftest.hcl assert that no *.tf file in this stack declares a credential resource.

resource "aws_iam_user" "writer" {
  name = local.writer_user_name
  path = local.writer_user_path

  lifecycle {
    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The archive must be out of reach of everything that can reach production; it needs its own account."
    }
  }
}

data "aws_iam_policy_document" "writer" {
  statement {
    sid       = "PutConsoleDocuments"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/${local.console_inbound_prefix}*"]
    condition {
      test     = "IpAddress"
      variable = "aws:SourceIp"
      values   = var.console_writer_source_cidrs
    }
  }

  # PutObject under SSE-KMS makes S3 call GenerateDataKey on the writer's behalf; completing a
  # multipart upload also calls Decrypt. ViaService confines both to requests that came through S3 —
  # which the statement above has already confined to the box. Decrypt grants no read: the writer
  # holds no s3:GetObject.
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
      values   = var.console_writer_source_cidrs
    }
    condition {
      test     = "Bool"
      variable = "aws:ViaAWSService"
      values   = ["false"]
    }
  }
}

resource "aws_iam_user_policy" "writer" {
  name   = "alethia-books-console-write"
  user   = aws_iam_user.writer.name
  policy = data.aws_iam_policy_document.writer.json
}
