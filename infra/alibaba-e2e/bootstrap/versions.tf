# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source = "aliyun/alicloud"
      # Same pin as the parent stack so both are applied against one provider generation.
      version = "~> 1.240"
    }
  }
}

# The maintainer authenticates natively (ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY, an `aliyun` CLI
# profile, or a RAM session) with an admin identity. No credential is ever written to state.
provider "alicloud" {
  region = var.region
}
