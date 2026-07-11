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

locals {
  secrets_by_name = { for s in var.secrets : s.name => s }
}

# Generate a random value for secrets that request it.
resource "random_password" "generated" {
  for_each = { for k, s in local.secrets_by_name : k => s if try(s.generate, false) }

  length  = try(each.value.length, 32)
  special = try(each.value.special_chars, true)
}

resource "alicloud_kms_secret" "this" {
  for_each = local.secrets_by_name

  secret_name = "${var.name_prefix}-${each.value.name}"
  version_id  = "v1"
  secret_data = try(each.value.generate, false) ? random_password.generated[each.key].result : try(each.value.value, "placeholder")
}
