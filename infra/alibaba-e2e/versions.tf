# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source = "aliyun/alicloud"
      # Pin >= 1.240 (< 2.0): this is the provider generation whose alicloud_ram_role exposes
      # the writable `assume_role_policy_document` trust attribute (the spelling the verify
      # gate's controls_alibaba.go parses) and the alicloud_ims_oidc_provider resource. Matches
      # the infra/connector/alibaba module's `>= 1.230`, bumped to the version the verify corpus
      # was captured against (v1.285.0).
      version = "~> 1.240"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
