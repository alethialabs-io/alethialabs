# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "zone_id" {
  description = "The Route 53 hosted zone id."
  value       = aws_route53_zone.zone.zone_id
}

output "name_servers" {
  description = "Authoritative name servers for the zone (delegate these at the registrar)."
  value       = aws_route53_zone.zone.name_servers
}
