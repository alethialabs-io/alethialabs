# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.230"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "alicloud" {
  region = var.region
  # Auth from the environment: short-lived STS credentials (ALICLOUD_SECURITY_TOKEN alongside the
  # key pair) or an `aliyun` CLI profile (ALICLOUD_PROFILE). CI only validates this stack.
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
