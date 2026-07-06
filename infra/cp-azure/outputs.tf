# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "server_ipv4" {
  description = "Public IP of the control-plane VM (set as DEPLOY_HOST)."
  value       = azurerm_public_ip.cp.ip_address
}

output "vm_name" {
  description = "VM name."
  value       = azurerm_linux_virtual_machine.cp.name
}
