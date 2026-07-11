# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "dns" {
  source = "./modules/dns"
  count  = var.alidns_enabled && var.dns_provider == "native" ? 1 : 0

  domain_name = var.alidns_domain
  group_name  = var.alidns_zone_name

  tags = local.common_tags
}
