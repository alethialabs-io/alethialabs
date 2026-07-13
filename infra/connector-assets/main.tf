# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Public-read S3 bucket that serves the cloud-connector setup artifacts the console
# and CLI hand out: the AWS CloudFormation template + the GCP/Azure Cloud Shell
# scripts. AWS CloudFormation quick-create requires an S3-hosted templateURL, so a
# plain bucket (no CloudFront) under the canonical
# https://<bucket>.s3.<region>.amazonaws.com/<key> URL is exactly what the app/CLI/docs
# point at. The objects are sourced from infra/connector/ (the single source of truth,
# also mirrored byte-for-byte into apps/console/public/ for the self-host fallback).
# IAM lives in ./bootstrap (admin-applied once); CI applies this with the deploy role.

locals {
  tags = {
    project = "alethia"
    role    = "connector-assets"
    managed = "opentofu"
  }

  # key (object name served at the bucket root) → source file in infra/connector/.
  artifacts = {
    "alethia-bootstrap.yaml" = {
      source       = "${path.module}/../connector/aws/alethia-bootstrap.yaml"
      content_type = "text/yaml"
    }
    "alethia-aws-setup.sh" = {
      source       = "${path.module}/../connector/aws/alethia-aws-setup.sh"
      content_type = "text/x-shellscript"
    }
    "alethia-gcp-setup.sh" = {
      source       = "${path.module}/../connector/gcp/alethia-gcp-setup.sh"
      content_type = "text/x-shellscript"
    }
    "alethia-azure-setup.sh" = {
      source       = "${path.module}/../connector/azure/alethia-azure-setup.sh"
      content_type = "text/x-shellscript"
    }
    "alethia-alibaba-setup.sh" = {
      source       = "${path.module}/../connector/alibaba/alethia-alibaba-setup.sh"
      content_type = "text/x-shellscript"
    }
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = var.bucket_name
  tags   = local.tags
}

# Public read served via a bucket policy (not ACLs) — disable ACLs entirely.
resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Allow a public-read bucket policy (the two public-policy guards are off; ACL guards
# stay on since ACLs are disabled above).
resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "public_read" {
  statement {
    sid     = "PublicReadGetObject"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = ["${aws_s3_bucket.assets.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = data.aws_iam_policy_document.public_read.json

  # The policy is only valid once the public-policy block is lifted.
  depends_on = [aws_s3_bucket_public_access_block.assets]
}

# Upload each artifact. etag = filemd5 so a script edit re-uploads on the next apply
# (the workflow also triggers on infra/connector/** changes). Short cache so edits
# propagate quickly.
resource "aws_s3_object" "artifact" {
  for_each = local.artifacts

  bucket        = aws_s3_bucket.assets.id
  key           = each.key
  source        = each.value.source
  etag          = filemd5(each.value.source)
  content_type  = each.value.content_type
  cache_control = "public, max-age=300"
  tags          = local.tags
}
