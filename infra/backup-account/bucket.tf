# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The off-box store. Four independent protections, so no single credential or mistake loses a copy:
#
#   1. Object Lock COMPLIANCE, 15 days by default. Inside the window no principal — root included —
#      can delete or overwrite a locked version, and lifecycle cannot expire it. Object Lock can only
#      be enabled when the bucket is CREATED, and can never be turned off or have versioning
#      suspended afterwards.
#   2. The box's key cannot delete at all (writer.tf), and the bucket policy below denies every
#      destructive or retention-changing action to anyone but the admins, so a stolen box key can
#      neither remove a version nor add a delete marker.
#   3. Retention is the bucket's lifecycle, not the box's: backup.sh's own prune step is replaced by
#      BACKUP_RETENTION=bucket (BKP-L1), so the box needs no delete right to keep 14 + 8 copies.
#   4. SSE-KMS under a key with prevent_destroy (kms.tf), on top of the age envelope.

resource "aws_s3_bucket" "backup" {
  bucket              = local.bucket_name
  object_lock_enabled = true
  force_destroy       = false

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The backups exist to be out of reach of everything that can reach production; they need their own account."
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    default_retention {
      mode = local.lock_mode
      days = local.lock_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.backup]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backup.arn
    }
    # One data key per bucket rather than one KMS call per object: cheaper, and the KMS request
    # volume stays negligible (README "Cost").
    bucket_key_enabled = true
  }
}

# Retention lives here, not on the box. A versioned bucket's "expiration" adds a delete marker and
# makes the data version noncurrent; noncurrent_days later the version itself is removed. Because
# noncurrent_days > lock_days, lifecycle never targets a version that is still locked.
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "daily-copies"
    status = "Enabled"
    filter {
      prefix = local.daily_prefix
    }
    expiration {
      days = local.daily_days
    }
  }

  rule {
    id     = "weekly-copies"
    status = "Enabled"
    filter {
      prefix = local.weekly_prefix
    }
    expiration {
      days = local.weekly_days
    }
  }

  rule {
    id     = "drill-evidence"
    status = "Enabled"
    filter {
      prefix = local.evidence_prefix
    }
    expiration {
      days = local.evidence_days
    }
  }

  # Whole bucket: overwritten versions (latest.json, the hourly tombstone export) and expired copies
  # go noncurrent_days after they stop being current; a delete marker with nothing left behind it is
  # cleaned up; a multipart upload the box abandoned is aborted (the writer has no
  # AbortMultipartUpload right of its own).
  rule {
    id     = "noncurrent-and-housekeeping"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = local.noncurrent_days
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.backup]
}

data "aws_iam_policy_document" "bucket" {
  # TLS only: any request over plain HTTP is refused, whoever makes it.
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # The bucket answers only the principals named in main.tf. AdministratorAccess on some other role
  # in this account, or the management account's OrganizationAccountAccessRole, gets nothing here.
  statement {
    sid       = "DenyEveryoneButTheNamedPrincipals"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = local.bucket_principal_patterns
    }
  }

  # Even the named non-admin principals can never delete, add a delete marker, touch retention or
  # legal holds, or change how the bucket itself is configured. Their IAM policies grant none of
  # this anyway; the Deny makes it hold even if one of those policies is later widened by mistake.
  statement {
    sid    = "DenyDestructiveAndRetentionChangesToNonAdmins"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:DeleteBucket",
      "s3:DeleteBucketPolicy",
      "s3:PutBucketPolicy",
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
      "s3:BypassGovernanceRetention",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketVersioning",
      "s3:PutEncryptionConfiguration",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketOwnershipControls",
    ]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]
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

resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = data.aws_iam_policy_document.bucket.json

  # The public-access block first, so the policy is never evaluated against a bucket without it.
  depends_on = [aws_s3_bucket_public_access_block.backup]
}
