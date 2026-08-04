# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "state_resource_group_name" {
  description = "Resource group holding the state storage account — backend.hcl's `resource_group_name`."
  value       = azurerm_resource_group.tfstate.name
}

output "state_storage_account_name" {
  description = "Storage account holding the state container — backend.hcl's `storage_account_name`."
  value       = azurerm_storage_account.tfstate.name
}

output "state_container_name" {
  description = "Blob container holding the state blobs — backend.hcl's `container_name`."
  value       = azurerm_storage_container.tfstate.name
}
