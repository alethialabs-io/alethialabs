output "server_fqdn" {
  description = "Fully qualified domain name of the database server"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server.this[0].fqdn : null
}

output "database_name" {
  description = "Name of the default database"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server_database.this[0].name : null
}

output "admin_username" {
  description = "Administrator login name"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server.this[0].administrator_login : null
}

output "server_name" {
  description = "PostgreSQL Flexible Server name (for the keyless AAD administrator, #722)"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server.this[0].name : null
}

output "admin_password" {
  description = "Administrator password"
  value       = random_password.admin.result
  sensitive   = true
}
