# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "server_ipv4" {
  description = "Public IPv4 of the sandbox box (scripts/env.sh rsyncs and ssh's here)."
  value       = hcloud_server.sandbox.ipv4_address
}

output "server_status" {
  description = "Server status."
  value       = hcloud_server.sandbox.status
}

output "server_type" {
  description = "Server type actually provisioned (capacity may have forced a fallback)."
  value       = hcloud_server.sandbox.server_type
}

output "env_domain" {
  description = "Domain under which branch environments are served."
  value       = local.env_domain
}

output "primary_env_url" {
  description = "The one hostname with social OAuth + Stripe webhooks registered."
  value       = "https://${local.env_domain}"
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID."
  value       = cloudflare_zero_trust_tunnel_cloudflared.sandbox.id
}

# Consumed by `pnpm env:up`, which writes it to /opt/alethia/cloudflared/credentials.json:
#   tofu output -raw tunnel_credentials
output "tunnel_credentials" {
  description = "credentials.json content for the locally-managed cloudflared connector."
  value       = local.tunnel_credentials
  sensitive   = true
}
