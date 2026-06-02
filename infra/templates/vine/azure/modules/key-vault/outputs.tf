output "vault_id" {
  description = "The resource ID of the key vault"
  value       = azurerm_key_vault.this.id
}

output "vault_uri" {
  description = "The URI of the key vault"
  value       = azurerm_key_vault.this.vault_uri
}

output "secret_ids" {
  description = "Map of secret names to their resource IDs"
  value       = { for k, v in azurerm_key_vault_secret.this : k => v.id }
}

output "secret_names" {
  description = "List of secret names created in the vault"
  value       = [for k, v in azurerm_key_vault_secret.this : v.name]
}
