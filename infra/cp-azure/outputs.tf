# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "vm_name" {
  description = "VM name (admin via: az vm run-command invoke -g <rg> -n <vm> ...; break-glass via Serial Console)."
  value       = azurerm_linux_virtual_machine.cp.name
}

output "resource_group_name" {
  description = "Resource group holding the control-plane VM."
  value       = azurerm_resource_group.cp.name
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID (CNAME target is <id>.cfargotunnel.com)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.id
}

# infra-cp-azure CI merges this into the alethia/prod/env vault as TUNNEL_TOKEN:
#   tofu output -raw tunnel_token
output "tunnel_token" {
  description = "Connector token for cloudflared (TUNNEL_TOKEN)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.cp.tunnel_token
  sensitive   = true
}
