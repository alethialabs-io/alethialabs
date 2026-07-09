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

# Web Application Firewall (v3) instance. WAF is only offered in a subset of
# regions and requires a paid subscription provisioned at the account level; the
# parent template gates this module behind `application_waf_enabled`. The v3
# instance resource reads the account's existing WAF instance (one per account).
resource "alicloud_wafv3_instance" "this" {}
