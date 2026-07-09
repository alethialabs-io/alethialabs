# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_name" {
  description = "GCE instance name (SSH via: gcloud compute ssh alethia-cp --tunnel-through-iap)."
  value       = google_compute_instance.cp.name
}

output "external_ip" {
  description = "Ephemeral external IP of the box — EGRESS only (inbound web via tunnel, SSH via IAP)."
  value       = google_compute_instance.cp.network_interface[0].access_config[0].nat_ip
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID (CNAME target is <id>.cfargotunnel.com)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.id
}

# infra-cp-gcp CI merges this into the alethia/prod/env vault as TUNNEL_TOKEN:
#   tofu output -raw tunnel_token
output "tunnel_token" {
  description = "Connector token for cloudflared (TUNNEL_TOKEN)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.tunnel_token
  sensitive   = true
}
