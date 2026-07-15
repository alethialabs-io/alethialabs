output "vnet_name" {
  description = "Name of the virtual network"
  value       = azurerm_virtual_network.this.name
}

output "vnet_id" {
  description = "ID of the virtual network"
  value       = azurerm_virtual_network.this.id
}

output "private_subnet_id" {
  description = "ID of the private subnet"
  value       = azurerm_subnet.private.id
}

output "public_subnet_id" {
  description = "ID of the public subnet"
  value       = azurerm_subnet.public.id
}

output "database_subnet_id" {
  description = "ID of the subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers (dedicated; a delegated subnet cannot host other resources)."
  value       = azurerm_subnet.database.id
}
