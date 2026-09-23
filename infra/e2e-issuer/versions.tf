# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v5, NOT the ~> 4.40 infra/sandbox pins: v4's resource is `cloudflare_worker_domain`, v5 renamed
      # it to `cloudflare_workers_custom_domain` and made `environment` optional-and-deprecated. The
      # attribute set this stack relies on (account_id, hostname, service, zone_id, computed cert_id;
      # cloudflare_dns_record's nested `data` for CAA; cloudflare_zone's `filter`) was read from the
      # 5.25.0 schema with `tofu providers schema -json`.
      version = "~> 5.25"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

# No `api_token` argument, on purpose: the provider reads CLOUDFLARE_API_TOKEN from the environment.
# A variable would put the token in the plan file and, for some provider paths, in state; an env var
# is in neither. The token is the ZONE-SCOPED apply token described in README.md — never the Worker
# deploy token the e2e-issuer GitHub environment holds.
provider "cloudflare" {}
