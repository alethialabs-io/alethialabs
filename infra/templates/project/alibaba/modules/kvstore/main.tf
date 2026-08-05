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

resource "alicloud_kvstore_instance" "this" {
  db_instance_name = var.instance_name
  instance_class   = var.instance_class
  instance_type    = "Redis"
  engine_version   = var.engine_version

  # null, not 0, when unset: passing 0 would ask Alibaba for a zero-shard instance. null omits the
  # argument entirely and the SKU decides, which is today's behaviour (#1996).
  shard_count = var.shard_count > 0 ? var.shard_count : null

  vswitch_id        = var.vswitch_id
  zone_id           = var.zone_id
  secondary_zone_id = var.multi_az && var.secondary_zone_id != "" ? var.secondary_zone_id : null

  tags = var.tags
}
