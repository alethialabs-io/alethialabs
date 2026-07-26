# Every output used to be `is_postgres ? … : null`, so selecting MySQL produced a server-less
# environment whose bindings silently resolved to nothing (#1382). They now answer for both engines.

output "server_fqdn" {
  description = "Fully qualified domain name of the database server"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server.this[0].fqdn : azurerm_mysql_flexible_server.this[0].fqdn
}

output "database_name" {
  description = "Name of the default database"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server_database.this[0].name : azurerm_mysql_flexible_database.this[0].name
}

output "admin_username" {
  description = "Administrator login name"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server.this[0].administrator_login : azurerm_mysql_flexible_server.this[0].administrator_login
}

output "server_name" {
  description = "Flexible Server name (for the keyless Entra administrator, #722)"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server.this[0].name : azurerm_mysql_flexible_server.this[0].name
}

# MySQL's Entra administrator resource keys on the server ID, not the name — PostgreSQL's keys on the
# name. Both are exported so the root module can wire either engine without reaching into the module.
output "server_id" {
  description = "Flexible Server resource id (the MySQL Entra administrator resource keys on this)"
  value       = local.is_postgres ? azurerm_postgresql_flexible_server.this[0].id : azurerm_mysql_flexible_server.this[0].id
}

output "admin_password" {
  description = "Administrator password"
  value       = random_password.admin.result
  sensitive   = true
}
