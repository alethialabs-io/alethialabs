# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v5, matching infra/e2e-issuer: the same zone, the same account, the same resource names
      # (cloudflare_dns_record, cloudflare_workers_script with a `bindings` list). The attribute set
      # this stack relies on was read from the provider schema with `tofu providers schema -json`.
      version = "~> 5.25"
    }
  }
}

# No `api_token` argument, on purpose (the infra/e2e-issuer convention): the provider reads
# CLOUDFLARE_API_TOKEN from the environment, so the token is in neither the plan nor the state.
provider "cloudflare" {}
