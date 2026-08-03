output "account_name" {
  description = "The name of the storage account"
  value       = azurerm_storage_account.this.name
}

output "primary_blob_endpoint" {
  description = "The primary blob endpoint URL"
  value       = azurerm_storage_account.this.primary_blob_endpoint
}

output "primary_access_key" {
  description = "The primary access key for the storage account"
  value       = azurerm_storage_account.this.primary_access_key
  sensitive   = true
}

output "container_names" {
  description = "List of created container names"
  value       = [for c in azurerm_storage_container.this : c.name]
}

# Surfaced so the two bucket switches are legible from the plan — and so the root-level
# checks_storage.tftest.hcl can assert the PLANNED resource attributes. A *.tftest.hcl under
# modules/ is silently never executed, so a test here would prove nothing.
output "container_access_types" {
  description = "Map of container name to the container_access_type it is planned with"
  value       = { for k, c in azurerm_storage_container.this : k => c.container_access_type }
}

output "blob_versioning_enabled" {
  description = "Whether blob versioning is planned on the account (any container asking for it turns it on)"
  # Read off the PLANNED resource, not off local.blob_versioning: restating the input would assert
  # only that it equals itself, and would still report true if the block stopped reading it.
  value = azurerm_storage_account.this.blob_properties[0].versioning_enabled
}

output "allow_nested_items_to_be_public" {
  description = "Whether the account permits public containers — a public container is inert without it"
  value       = azurerm_storage_account.this.allow_nested_items_to_be_public
}
