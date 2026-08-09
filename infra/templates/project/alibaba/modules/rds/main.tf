# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# A generated password for the default account; surfaced as a sensitive output.
resource "random_password" "account" {
  length           = 24
  special          = true
  override_special = "!#$%^&*()-_=+"
}

resource "alicloud_db_instance" "this" {
  instance_name    = var.instance_name
  engine           = var.engine
  engine_version   = var.engine_version
  instance_type    = var.instance_type
  instance_storage = var.instance_storage
  vswitch_id       = var.vswitch_id

  db_instance_storage_type = "cloud_essd"

  # Serverless scaling range (#1996). Rendered only when a bound was actually set — an empty block
  # is not "no serverless", it declares the instance serverless with zero capacity, and adding one
  # unconditionally would change every existing fixed-size instance.
  dynamic "serverless_config" {
    for_each = var.serverless_min_capacity > 0 || var.serverless_max_capacity > 0 ? [1] : []
    content {
      min_capacity = var.serverless_min_capacity
      max_capacity = var.serverless_max_capacity
    }
  }

  tags = var.tags
}

# Automated backup retention.
resource "alicloud_db_backup_policy" "this" {
  instance_id             = alicloud_db_instance.this.id
  backup_retention_period = var.backup_retention_days
}

resource "alicloud_db_database" "this" {
  instance_id    = alicloud_db_instance.this.id
  data_base_name = var.database_name
}

resource "alicloud_rds_account" "this" {
  db_instance_id   = alicloud_db_instance.this.id
  account_name     = var.account_name
  account_password = random_password.account.result
  account_type     = "Normal"
}

resource "alicloud_db_account_privilege" "this" {
  instance_id  = alicloud_db_instance.this.id
  account_name = alicloud_rds_account.this.account_name
  privilege    = "ReadWrite"
  db_names     = [alicloud_db_database.this.data_base_name]
}
