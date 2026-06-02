output "account_endpoint" {
  description = "The endpoint URL of the Cosmos DB account"
  value       = azurerm_cosmosdb_account.this.endpoint
}

output "account_id" {
  description = "The resource ID of the Cosmos DB account"
  value       = azurerm_cosmosdb_account.this.id
}

output "primary_key" {
  description = "The primary key for the Cosmos DB account"
  value       = azurerm_cosmosdb_account.this.primary_key
  sensitive   = true
}

output "database_name" {
  description = "The name of the SQL database (empty string if kind is MongoDB)"
  value       = var.kind == "GlobalDocumentDB" ? azurerm_cosmosdb_sql_database.this[0].name : ""
}
