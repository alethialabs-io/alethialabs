# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# S3 bucket holding OpenTofu state for the SES stacks (keys ses/ and
# ses-bootstrap/). Created here in bootstrap (admin) so the deploy role only needs
# object read/write, not bucket-creation rights. It lives in the same account as
# the SES resources, so the OIDC deploy role authenticates the backend natively —
# no static state credentials anywhere.

resource "aws_s3_bucket" "tofu_state" {
  bucket = var.state_bucket_name
  tags   = local.tags

  # State is the source of truth — never let a destroy take the bucket.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tofu_state" {
  bucket = aws_s3_bucket.tofu_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tofu_state" {
  bucket = aws_s3_bucket.tofu_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tofu_state" {
  bucket                  = aws_s3_bucket.tofu_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
