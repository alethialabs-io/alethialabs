# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "server_ipv4" {
  description = "Public IPv4 of the status box."
  value       = hcloud_server.status.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 of the status box."
  value       = hcloud_server.status.ipv6_address
}

# Reminder of the Cloudflare records to add by hand (DNS-only / grey cloud so
# Caddy's ACME HTTP-01 challenge reaches the box). DNS is intentionally not
# managed by this Terraform.
output "dns_records_to_add" {
  description = "Cloudflare records to create manually in the alethialabs.io zone."
  value       = <<-EOT
    status  A     ${hcloud_server.status.ipv4_address}   (DNS only / grey cloud)
    status  AAAA  ${hcloud_server.status.ipv6_address}   (DNS only / grey cloud, optional)
  EOT
}
