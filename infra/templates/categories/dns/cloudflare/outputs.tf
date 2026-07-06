# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "dns_provider" {
  description = "Identifies the active DNS provider for downstream consumers."
  value       = "cloudflare"
}

output "zone_id" {
  value = var.cloudflare_zone_id
}
