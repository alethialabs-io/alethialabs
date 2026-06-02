output "name_servers" {
  description = "List of name servers for the DNS zone"
  value       = azurerm_dns_zone.this.name_servers
}

output "zone_name" {
  description = "The name of the DNS zone"
  value       = azurerm_dns_zone.this.name
}

output "zone_id" {
  description = "The resource ID of the DNS zone"
  value       = azurerm_dns_zone.this.id
}
