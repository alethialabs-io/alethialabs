# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cloudflare DNS — pluggable alternative to the cluster cloud's native DNS.
# Composed into the plan by the runner (categories.Compose) when a Project selects
# Cloudflare for its DNS provider. The cluster cloud's native DNS/cert resources
# are guarded off via the `dns_provider` variable in the project/<cloud> templates.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Wildcard CNAME for app workloads, pointing at the cluster ingress once known.
# Created only after the ingress hostname is available (post-cluster), so the
# first plan composes cleanly and records appear on the apply that has an ingress.
resource "cloudflare_record" "wildcard" {
  count   = var.ingress_hostname == "" ? 0 : 1
  zone_id = var.cloudflare_zone_id
  name    = "*.${var.domain_name}"
  type    = "CNAME"
  content = var.ingress_hostname
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
}

resource "cloudflare_record" "apex" {
  count   = var.ingress_hostname == "" ? 0 : 1
  zone_id = var.cloudflare_zone_id
  name    = var.domain_name
  type    = "CNAME"
  content = var.ingress_hostname
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
}
