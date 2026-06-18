# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "server_ipv4" {
  description = "Public IPv4 of the control-plane server."
  value       = hcloud_server.cp.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 of the control-plane server."
  value       = hcloud_server.cp.ipv6_address
}

output "server_status" {
  description = "Server status."
  value       = hcloud_server.cp.status
}
