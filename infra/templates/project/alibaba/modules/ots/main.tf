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
  # Key the tables list by name so for_each is stable.
  tables_by_name = { for t in var.tables : t.name => t }
}

resource "alicloud_ots_instance" "this" {
  name          = var.instance_name
  instance_type = "Capacity"
  tags          = var.tags
}

resource "alicloud_ots_table" "this" {
  for_each = local.tables_by_name

  instance_name = alicloud_ots_instance.this.name
  table_name    = each.value.name

  # No `try(…, [{ name = "id", type = "String" }])` fallback here any more — see #1836. That default
  # was not a convenience, it was the bug: the provider emitted the key under a different name, `try`
  # caught the miss, and every table in every Alibaba project was built on `id`/`String` while the
  # plan stayed clean. `tables` is now a typed object, so a caller that sends the wrong shape gets a
  # plan error instead of a silently wrong table.
  dynamic "primary_key" {
    for_each = each.value.primary_keys
    content {
      name = primary_key.value.name
      type = primary_key.value.type
    }
  }

  time_to_live = each.value.time_to_live
  max_version  = each.value.max_version
}
