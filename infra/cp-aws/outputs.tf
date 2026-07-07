# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_id" {
  description = "EC2 instance ID (SSH via: aws ssm start-session --target <id>)."
  value       = aws_instance.cp.id
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID (CNAME target is <id>.cfargotunnel.com)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.id
}

# infra-cp-aws CI merges this into the alethia/prod/env vault as TUNNEL_TOKEN:
#   tofu output -raw tunnel_token
output "tunnel_token" {
  description = "Connector token for cloudflared (TUNNEL_TOKEN)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.tunnel_token
  sensitive   = true
}
