# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_id" {
  description = "ECS instance ID (admin via ECS Session Manager / Cloud Assistant RunCommand)."
  value       = alicloud_instance.cp.id
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID (CNAME target is <id>.cfargotunnel.com)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.id
}

# infra-cp-alibaba CI merges this into the alethia/prod/env vault as TUNNEL_TOKEN:
#   tofu output -raw tunnel_token
output "tunnel_token" {
  description = "Connector token for cloudflared (TUNNEL_TOKEN)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.tunnel_token
  sensitive   = true
}
