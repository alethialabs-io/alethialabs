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
  buckets_by_name = { for b in var.buckets : b.name => b }
}

resource "alicloud_oss_bucket" "this" {
  for_each = local.buckets_by_name

  bucket        = each.value.name
  storage_class = try(each.value.storage_class, "Standard")
  force_destroy = try(each.value.force_destroy, false)
  tags          = var.tags

  dynamic "versioning" {
    for_each = try(each.value.versioning, false) ? [1] : []
    content {
      status = "Enabled"
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
