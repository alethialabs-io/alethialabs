# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The archive. Independent protections, so no single credential or mistake loses a record:
#
#   1. Object Lock COMPLIANCE, 4018 days (11 years) by default. Inside the window no principal —
#      root included — can delete or overwrite a locked version, and lifecycle cannot expire it.
#      Object Lock can only be enabled when the bucket is CREATED and can never be turned off.
#   2. Neither writer can delete at all (oidc.tf, writer.tf), and the bucket policy below denies
#      every destructive, retention-changing or bucket-configuring action to anyone but the admins,
#      so a stolen key can neither remove a version, add a delete marker, nor loosen the bucket.
#   3. NOTHING expires. The only lifecycle rule aborts multipart uploads a writer abandoned.
#   4. SSE-KMS under a key with prevent_destroy and a deny-delete key policy (kms.tf).

resource "aws_s3_bucket" "archive" {
  bucket              = local.bucket_name
  object_lock_enabled = true
  force_destroy       = false

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.backup_account_id != var.alethia_account_id
      error_message = "backup_account_id equals alethia_account_id. The archive must be out of reach of everything that can reach production; it needs its own account."
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    default_retention {
      mode = local.lock_mode
      days = local.lock_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.archive.arn
    }
    # One data key per bucket rather than one KMS call per object (README "Cost").
    bucket_key_enabled = true
  }
}

# Housekeeping ONLY. No expiration, no noncurrent-version expiration, no transition: a record is kept
# for good unless an admin removes it after its lock ends. checks.tf and the test assert there is
# exactly this one rule and that it carries no expiry of any kind.
resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = local.abort_multipart_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

locals {
  # Named once so checks.tf and the test read the same list the policy denies.
  bucket_admin_only_actions = [
    "s3:DeleteObject",
    "s3:DeleteObjectVersion",
    "s3:DeleteObjectTagging",
    "s3:DeleteObjectVersionTagging",
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
    "s3:PutBucketAcl",
    "s3:PutObjectAcl",
    "s3:PutObjectVersionAcl",
    "s3:PutReplicationConfiguration",
    "s3:PutBucketCORS",
    "s3:PutBucketWebsite",
    "s3:PutBucketNotification",
  ]
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

  # The bucket answers only the principals named in main.tf. AdministratorAccess on some other role in
  # this account (the backup stack's identities included), or the management account's
  # OrganizationAccountAccessRole, gets nothing here.
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
  # legal holds, or change how the bucket itself is configured. Their IAM policies grant none of this;
  # the Deny makes it hold even if one of those policies is later widened by mistake.
  statement {
    sid       = "DenyDestructiveRetentionAndConfigChangesToNonAdmins"
    effect    = "Deny"
    actions   = local.bucket_admin_only_actions
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

resource "aws_s3_bucket_policy" "archive" {
  bucket = aws_s3_bucket.archive.id
  policy = data.aws_iam_policy_document.bucket.json

  # The public-access block first, so the policy is never evaluated against a bucket without it.
  depends_on = [aws_s3_bucket_public_access_block.archive]
}
