# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v5, the same major infra/e2e-issuer pins. The R2 resources this stack uses
      # (cloudflare_r2_bucket, _r2_custom_domain, _r2_managed_domain, _r2_bucket_cors) and the
      # ruleset's cache-settings action were read from the provider schema with
      # `tofu providers schema -json`, not from memory.
      version = "~> 5.25"
    }
  }
}

# No `api_token` argument, on purpose: the provider reads CLOUDFLARE_API_TOKEN from the environment,
# so the token is in neither a plan file nor state. Which permissions that token needs is in README.md.
provider "cloudflare" {}
