# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "domain_name" {
  description = "Managed domain name"
  value       = alicloud_alidns_domain.this.domain_name
}

output "name_servers" {
  description = "AliDNS name servers for the domain"
  value       = alicloud_alidns_domain.this.dns_servers
}
