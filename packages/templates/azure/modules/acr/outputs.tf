output "login_server" {
  description = "The login server URL of the container registry"
  value       = azurerm_container_registry.this.login_server
}

output "registry_id" {
  description = "The resource ID of the container registry"
  value       = azurerm_container_registry.this.id
}

output "registry_name" {
  description = "The name of the container registry"
  value       = azurerm_container_registry.this.name
}
