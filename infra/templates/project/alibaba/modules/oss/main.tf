# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230"
    }
  }
}

locals {
  buckets_by_name = { for b in var.buckets : b.name_suffix => b }
}

resource "alicloud_oss_bucket" "this" {
  for_each = local.buckets_by_name

  # OSS bucket names are globally unique across every Alibaba Cloud account, so the canvas's plain
  # component name ("assets") is never an available bucket name. The project prefix is what makes it
  # one — the same composition GCP's cloud-storage module performs on its own name_suffix.
  bucket        = "${var.name_prefix}-${each.key}"
  storage_class = try(each.value.storage_class, "Standard")
  force_destroy = try(each.value.force_destroy, false)
  tags          = var.tags

  dynamic "versioning" {
    for_each = try(each.value.versioning, false) ? [1] : []
    content {
      status = "Enabled"
    }
  }

  # ENCRYPTION AT REST. OSS is not S3: it applies NO server-side encryption to a new bucket, so an
  # absent rule means objects are stored unencrypted rather than encrypted with a service default
  # (#1814). "None" is the OFF position and produces no block at all — the state OSS itself reports
  # as 400 NoSuchServerSideEncryptionRule.
  #
  # The provider sets this on the CreateBucket call, so there is no create-then-patch window in which
  # objects could land unencrypted. It governs objects written AFTER the rule exists: turning it on
  # for a bucket that already holds data does NOT re-encrypt what is already there.
  dynamic "server_side_encryption_rule" {
    for_each = try(each.value.sse_algorithm, "None") == "None" ? [] : [each.value.sse_algorithm]
    content {
      sse_algorithm = server_side_encryption_rule.value
    }
  }
}

# ACL is a dedicated resource in current provider versions (the inline `acl`
# argument on the bucket is deprecated).
resource "alicloud_oss_bucket_acl" "this" {
  for_each = local.buckets_by_name

  bucket = alicloud_oss_bucket.this[each.key].bucket
  acl    = try(each.value.acl, "private")
}
