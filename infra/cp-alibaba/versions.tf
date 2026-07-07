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
  # Auth via ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY env in CI.
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
