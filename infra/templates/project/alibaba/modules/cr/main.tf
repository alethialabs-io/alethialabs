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

# Container Registry Enterprise Edition instance.
resource "alicloud_cr_ee_instance" "this" {
  payment_type  = "Subscription"
  period        = 1
  instance_type = "Basic"
  instance_name = var.instance_name
}

# Namespace inside the CR EE instance.
resource "alicloud_cr_ee_namespace" "this" {
  instance_id        = alicloud_cr_ee_instance.this.id
  name               = var.namespace_name
  auto_create        = false
  default_visibility = "PRIVATE"
}
