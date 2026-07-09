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

  dynamic "primary_key" {
    for_each = try(each.value.primary_keys, [{ name = "id", type = "String" }])
    content {
      name = primary_key.value.name
      type = primary_key.value.type
    }
  }

  time_to_live = try(each.value.time_to_live, -1)
  max_version  = try(each.value.max_version, 1)
}
