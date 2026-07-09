# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# In-template Route 53 hosted zone (parity with GCP cloud-dns / Azure azure-dns, which create
# their managed zone). Enabled only when the caller wants Alethia to own the zone AND DNS is
# cloud-native (not delegated to a pluggable provider like Cloudflare). When disabled, the
# existing zone id in var.dns_hosted_zone is used instead (see acm-certificate.tf / outputs.tf).
module "route53" {
  count  = var.cloud_dns_enabled && var.dns_provider == "native" ? 1 : 0
  source = "./modules/route53"

  domain      = var.dns_main_domain
  environment = var.environment
  zone_name   = var.cloud_dns_zone_name
}
