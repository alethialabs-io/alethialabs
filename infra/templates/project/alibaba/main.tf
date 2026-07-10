# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  backend "http" {}

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230, < 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# The provider reads credentials from the environment (ALICLOUD_ACCESS_KEY,
# ALICLOUD_SECRET_KEY, ALICLOUD_SECURITY_TOKEN) that the runner exports from the
# keyless OIDC identity (AssumeRoleWithOIDC). No access-key variables are declared.
provider "alicloud" {
  region = var.region
}
