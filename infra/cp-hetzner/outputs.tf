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

output "tunnel_id" {
  description = "Cloudflare Tunnel ID (CNAME target is <id>.cfargotunnel.com)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.id
}

# infra-cp-hetzner CI merges this into the alethia/prod/env vault as TUNNEL_TOKEN:
#   tofu output -raw tunnel_token
output "tunnel_token" {
  description = "Connector token for cloudflared (TUNNEL_TOKEN)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.tunnel_token
  sensitive   = true
}
